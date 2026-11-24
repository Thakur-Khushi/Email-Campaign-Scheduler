import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

let transporterPromise: Promise<Transporter> | null = null;

// Bound how long a single send can take, so it always finishes (or fails)
// well inside STALE_CLAIM_MS. Otherwise a hung send could look like a
// crashed worker and get taken over by another worker.
const SMTP_TIMEOUTS = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 60_000,
};

async function buildTransporter(): Promise<Transporter> {
  if (env.etherealUser && env.etherealPass) {
    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: env.etherealUser, pass: env.etherealPass },
      ...SMTP_TIMEOUTS,
    });
  }

  const testAccount = await nodemailer.createTestAccount();
  console.log("[mailer] Generated Ethereal test account:");
  console.log(`[mailer]   user: ${testAccount.user}`);
  console.log(`[mailer]   pass: ${testAccount.pass}`);
  console.log("[mailer] Set ETHEREAL_USER/ETHEREAL_PASS in .env to reuse this account.");

  return nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: { user: testAccount.user, pass: testAccount.pass },
    ...SMTP_TIMEOUTS,
  });
}

function getTransporter(): Promise<Transporter> {
  if (!transporterPromise) {
    transporterPromise = buildTransporter();
  }
  return transporterPromise;
}

export interface SendResult {
  previewUrl: string | null;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<SendResult> {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: '"ReachInbox Scheduler" <scheduler@example.com>',
    to,
    subject,
    text: body,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  return { previewUrl };
}
