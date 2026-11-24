import { DelayedError, Job, Worker } from "bullmq";
import { createRedisConnection } from "../config/redis";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import {
  EMAIL_QUEUE_NAME,
  EmailJobData,
  emailJobId,
  enqueueEmailJob,
  ensureEmailJob,
} from "../queues/emailQueue";
import { tryReserveSlot, nextDeferPosition } from "../services/rateLimiter";
import { sendEmail } from "../services/mailer";
import { HOUR_MS } from "../services/scheduler";
import { claimableWhere, reconcilePendingJobs } from "../services/reconcile";

async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<void> {
  const { recipientId } = job.data;

  const recipient = await prisma.emailRecipient.findUnique({
    where: { id: recipientId },
    include: { campaign: true },
  });
  if (!recipient) {
    console.warn(`[worker] Recipient ${recipientId} no longer exists, skipping`);
    return;
  }
  if (recipient.status === "SENT" || recipient.status === "FAILED") {
    console.log(`[worker] ${recipientId} already ${recipient.status}, skipping duplicate job`);
    return;
  }

  // Only the job matching the row's current window may send it (see
  // emailJobId). Anything else is obsolete, e.g. a job from before a
  // deferral. Before dropping it, make sure the current job exists, in case
  // a deferral updated the row but its enqueue failed.
  if (job.id !== emailJobId(recipientId, recipient.windowIndex)) {
    if (recipient.status === "SCHEDULED") {
      await ensureEmailJob(recipientId, recipient.scheduledAt, recipient.windowIndex);
    }
    console.log(`[worker] Job ${job.id} is obsolete for ${recipientId}, skipping`);
    return;
  }

  // Atomic claim (compare-and-swap): succeeds if the row is SCHEDULED, or if
  // it's PROCESSING but the claim is stale (the worker that took it crashed).
  // SENT/FAILED rows never match, so they're never re-sent.
  const now = new Date();
  const claim = await prisma.emailRecipient.updateMany({
    where: { id: recipientId, ...claimableWhere(now) },
    data: { status: "PROCESSING", claimedAt: now },
  });
  if (claim.count === 0) {
    const current = await prisma.emailRecipient.findUnique({
      where: { id: recipientId },
      select: { status: true, claimedAt: true },
    });
    if (current?.status === "PROCESSING" && current.claimedAt && token) {
      // Someone holds a fresh claim. Usually this is BullMQ re-running a job
      // whose worker died seconds ago. Don't drop it: come back once the claim
      // goes stale, and the claim above will take it over if it's still stuck.
      const retryAt = current.claimedAt.getTime() + env.staleClaimMs + 1000;
      await job.moveToDelayed(retryAt, token);
      console.log(
        `[worker] ${recipientId} is claimed by another attempt, re-checking at ${new Date(retryAt).toISOString()}`
      );
      throw new DelayedError();
    }
    console.log(`[worker] ${recipientId} already handled, skipping duplicate job`);
    return;
  }

  // Hourly rate limit enforced against Redis (shared across every worker
  // process), not an in-memory counter.
  const reserved = await tryReserveSlot(
    recipient.campaignId,
    recipient.windowIndex,
    recipient.campaign.hourlyLimit
  );

  if (!reserved) {
    const newWindowIndex = recipient.windowIndex + 1;
    const windowStart =
      recipient.campaign.startTime.getTime() + newWindowIndex * HOUR_MS;
    const position = await nextDeferPosition(recipient.campaignId, newWindowIndex);
    const newScheduledAt = new Date(
      windowStart + position * recipient.campaign.delayMs
    );

    // DB first, then queue. If the enqueue fails, this job errors and its
    // retry sees itself as obsolete, which re-creates the new window's job
    // (see the obsolete-job check above).
    await prisma.emailRecipient.update({
      where: { id: recipientId },
      data: {
        status: "SCHEDULED",
        scheduledAt: newScheduledAt,
        windowIndex: newWindowIndex,
        claimedAt: null,
      },
    });

    await enqueueEmailJob(recipientId, newScheduledAt, newWindowIndex);

    console.log(
      `[worker] Hourly limit reached for campaign ${recipient.campaignId}, deferred ${recipientId} to window ${newWindowIndex}`
    );
    return;
  }

  try {
    const { previewUrl } = await sendEmail(
      recipient.recipient,
      recipient.subject,
      recipient.body
    );

    await prisma.emailRecipient.update({
      where: { id: recipientId },
      data: { status: "SENT", sentAt: new Date(), previewUrl, claimedAt: null },
    });

    console.log(`[worker] Sent to ${recipient.recipient} (${previewUrl})`);
  } catch (err) {
    const attempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;

    if (isFinalAttempt) {
      await prisma.emailRecipient.update({
        where: { id: recipientId },
        data: { status: "FAILED", error: (err as Error).message, claimedAt: null },
      });
    } else {
      // Revert the claim so the retry's compare-and-swap can succeed again.
      await prisma.emailRecipient.update({
        where: { id: recipientId },
        data: { status: "SCHEDULED", claimedAt: null },
      });
    }
    throw err;
  }
}

// autorun: false so the reconcile pass finishes before any job is processed.
const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
  connection: createRedisConnection(),
  concurrency: env.workerConcurrency,
  autorun: false,
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on("ready", () => {
  console.log(
    `[worker] Listening on "${EMAIL_QUEUE_NAME}" with concurrency=${env.workerConcurrency}`
  );
});

async function start() {
  const { scanned, enqueued } = await reconcilePendingJobs();
  console.log(
    `[worker] Reconcile: checked ${scanned} pending row(s), re-enqueued ${enqueued} missing job(s)`
  );
  worker.run().catch((err) => {
    console.error("[worker] Worker stopped with an error:", err);
    process.exit(1);
  });
}

start().catch((err) => {
  console.error("[worker] Startup reconcile failed:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});
