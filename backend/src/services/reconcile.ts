import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import { ensureEmailJob } from "../queues/emailQueue";

const BATCH_SIZE = 500;

/**
 * Rows a worker is allowed to claim: SCHEDULED, or PROCESSING with a claim
 * older than STALE_CLAIM_MS (the worker that claimed it is presumed dead).
 * A null claimedAt on a PROCESSING row can only come from a claim made
 * before the claimedAt column existed, so it's treated as stale too.
 * SENT and FAILED never match, so they can never be re-sent.
 */
export function claimableWhere(now: Date): Prisma.EmailRecipientWhereInput {
  const staleBefore = new Date(now.getTime() - env.staleClaimMs);
  return {
    OR: [
      { status: "SCHEDULED" },
      {
        status: "PROCESSING",
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
    ],
  };
}

export interface ReconcileResult {
  scanned: number;
  enqueued: number;
}

/**
 * Re-creates missing BullMQ jobs for rows that should have one. This covers the
 * DB/queue dual write: rows committed to Postgres whose enqueue never happened
 * (Redis down, process died in between), plus rows stuck in PROCESSING by a
 * crashed worker.
 *
 * Each row's job id is derived from its current (id, windowIndex). See
 * emailJobId() in queues/emailQueue.ts. A job that's already pending is left
 * alone, so running this is idempotent.
 */
export async function reconcilePendingJobs(): Promise<ReconcileResult> {
  const where = claimableWhere(new Date());
  let scanned = 0;
  let enqueued = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.emailRecipient.findMany({
      where,
      select: { id: true, scheduledAt: true, windowIndex: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;

    const added = await Promise.all(
      rows.map((row) => ensureEmailJob(row.id, row.scheduledAt, row.windowIndex))
    );
    scanned += rows.length;
    enqueued += added.filter(Boolean).length;
    cursor = rows[rows.length - 1].id;

    if (rows.length < BATCH_SIZE) break;
  }

  return { scanned, enqueued };
}
