import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import { assignSendSlots } from "../services/scheduler";
import { enqueueEmailJob } from "../queues/emailQueue";
import { EMAIL_REGEX } from "../services/recipientParser";

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_HOURLY_LIMIT = 10_000;
const START_TIME_GRACE_MS = 60 * 1000;
const ENQUEUE_TIMEOUT_MS = 10_000;

interface CreateCampaignBody {
  subject: string;
  body: string;
  recipients: string[];
  startTime: string;
  delayMs: number;
  hourlyLimit: number;
}

function normalizeRecipients(input: unknown[]): { valid: string[]; invalidCount: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  let invalidCount = 0;

  for (const raw of input) {
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!EMAIL_REGEX.test(email)) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    valid.push(email);
  }

  return { valid, invalidCount };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  // The Redis connection retries forever while Redis is down, so without a
  // timeout an enqueue would hang the request instead of failing.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function createCampaign(req: Request, res: Response) {
  const user = req.user!;
  const { subject, body, recipients, startTime, delayMs, hourlyLimit } =
    req.body as CreateCampaignBody;

  if (typeof subject !== "string" || typeof body !== "string" || !subject.trim() || !body.trim()) {
    return res.status(400).json({ error: "Subject and body are required" });
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return res
      .status(400)
      .json({ error: `Subject must be at most ${MAX_SUBJECT_LENGTH} characters` });
  }
  if (body.length > MAX_BODY_LENGTH) {
    return res
      .status(400)
      .json({ error: `Body must be at most ${MAX_BODY_LENGTH} characters` });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "At least one recipient is required" });
  }
  const { valid, invalidCount } = normalizeRecipients(recipients);
  if (valid.length === 0) {
    return res.status(400).json({ error: "No valid recipient email addresses" });
  }
  if (valid.length > env.maxRecipients) {
    return res.status(400).json({
      error: `Too many recipients: ${valid.length} (maximum is ${env.maxRecipients} per campaign)`,
    });
  }

  const start = new Date(startTime);
  if (isNaN(start.getTime())) {
    return res.status(400).json({ error: "Invalid startTime" });
  }
  if (start.getTime() < Date.now() - START_TIME_GRACE_MS) {
    return res.status(400).json({ error: "startTime cannot be in the past" });
  }

  const delay = Math.round(Number(delayMs));
  const limit = Number(hourlyLimit);
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
    return res
      .status(400)
      .json({ error: `delayMs must be between 0 and ${MAX_DELAY_MS} (1 hour)` });
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HOURLY_LIMIT) {
    return res
      .status(400)
      .json({ error: `hourlyLimit must be a whole number between 1 and ${MAX_HOURLY_LIMIT}` });
  }

  const slots = assignSendSlots(valid.length, start, delay, limit);

  // createMany doesn't return rows, so ids are generated here to know what
  // to enqueue after the commit.
  const rows = valid.map((recipient, i) => ({
    id: randomUUID(),
    recipient,
    scheduledAt: slots[i].scheduledAt,
    windowIndex: slots[i].windowIndex,
  }));

  const campaign = await prisma.$transaction(
    async (tx) => {
      const created = await tx.campaign.create({
        data: {
          userId: user.id,
          subject,
          body,
          startTime: start,
          delayMs: delay,
          hourlyLimit: limit,
        },
      });

      await tx.emailRecipient.createMany({
        data: rows.map((row) => ({
          ...row,
          campaignId: created.id,
          userId: user.id,
          subject,
          body,
        })),
      });

      return created;
    },
    { timeout: 30_000 }
  );

  // The rows are committed. If enqueueing fails now, the worker's startup
  // reconcile pass (services/reconcile.ts) re-creates the missing jobs, so
  // don't fail the request.
  let warning: string | undefined;
  try {
    await withTimeout(
      Promise.all(
        rows.map((row) => enqueueEmailJob(row.id, row.scheduledAt, row.windowIndex))
      ),
      ENQUEUE_TIMEOUT_MS
    );
  } catch (err) {
    console.error(
      `[campaigns] Campaign ${campaign.id} saved but enqueueing failed:`,
      (err as Error).message
    );
    warning =
      "Campaign saved, but some sends could not be queued yet. They will be queued automatically the next time the worker starts.";
  }

  return res.status(201).json({
    campaignId: campaign.id,
    scheduled: rows.length,
    invalidSkipped: invalidCount,
    firstSendAt: slots[0]?.scheduledAt,
    lastSendAt: slots[slots.length - 1]?.scheduledAt,
    ...(warning ? { warning } : {}),
  });
}
