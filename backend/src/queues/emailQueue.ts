import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis";

export const EMAIL_QUEUE_NAME = "email-queue";

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export interface EmailJobData {
  recipientId: string;
}

/**
 * The single jobId scheme for every email job: one job per
 * (recipient row, hour window), e.g. "<uuid>-w0", "<uuid>-w1".
 *
 * - The first enqueue (campaign creation), the rate-limit deferral and the
 *   startup reconcile pass all derive the id from the row's *current*
 *   windowIndex, so anyone can compute "the job that should exist for this
 *   row right now". Re-adding it is a no-op while that job is still in Redis.
 * - A deferral bumps windowIndex, so it gets a fresh id. It can't reuse the
 *   id of the job that's currently running (BullMQ would ignore the add).
 * - "-" rather than ":" because BullMQ rejects custom ids containing ":".
 *
 * The jobId only dedupes queue entries. Duplicate sends are prevented by the
 * row-level claim in the worker, which never touches SENT/FAILED rows.
 */
export function emailJobId(recipientId: string, windowIndex: number): string {
  return `${recipientId}-w${windowIndex}`;
}

export async function enqueueEmailJob(
  recipientId: string,
  scheduledAt: Date,
  windowIndex: number
) {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await emailQueue.add(
    "send-email",
    { recipientId } as EmailJobData,
    {
      jobId: emailJobId(recipientId, windowIndex),
      delay,
    }
  );
}

/**
 * Makes sure the job for the row's current (id, windowIndex) is pending.
 * Unlike a plain add, this also handles the case where that jobId is still
 * retained in the completed/failed set (so add() would silently no-op) but
 * the row was never actually sent. The old entry is removed and re-added.
 * Returns true if a job was (re-)added.
 */
export async function ensureEmailJob(
  recipientId: string,
  scheduledAt: Date,
  windowIndex: number
): Promise<boolean> {
  const existing = await emailQueue.getJob(emailJobId(recipientId, windowIndex));
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed") {
      return false; // already waiting, delayed or active
    }
    await existing.remove();
  }
  await enqueueEmailJob(recipientId, scheduledAt, windowIndex);
  return true;
}
