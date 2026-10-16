// Outbound channels: email (SMTP), SMS (Twilio), webhooks. Every send goes
// through deliver(), which records a notification_deliveries row when a
// workspace is involved. Nothing leaves the system unless NOTIFICATIONS_ENABLED.
import nodemailer, { type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/client";
import { notificationDeliveries, type Channel } from "@shared/schema";
import { log, errorFields } from "../lib/log";
import { isBlockedAddress } from "../lib/netpolicy";

export type Message = { subject: string; text: string; html?: string };
type Kind = "failure" | "recovery" | "test" | "invite" | "password";

let transporter: Transporter | null = null;
function mailer(): Transporter | null {
  if (!config.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? (config.SMTP_SECURE ? 465 : 587),
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return transporter;
}

export function channelStatus() {
  return {
    enabled: config.NOTIFICATIONS_ENABLED,
    email: !!config.SMTP_HOST && !!config.MAIL_FROM,
    sms: !!(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM),
    webhook: true,
  };
}

export function maskTarget(channel: Channel, target: string): string {
  if (channel === "email") {
    const [user, domain] = target.split("@");
    return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain ?? ""}`;
  }
  if (channel === "sms") return `•••${target.replace(/\D/g, "").slice(-4)}`;
  try {
    return new URL(target).host;
  } catch {
    return "webhook";
  }
}

async function sendEmail(to: string, msg: Message) {
  const t = mailer();
  if (!t || !config.MAIL_FROM) throw new Error("Email is not configured (SMTP_HOST and MAIL_FROM).");
  await t.sendMail({ from: config.MAIL_FROM, to, subject: msg.subject, text: msg.text, html: msg.html });
}

async function sendSms(to: string, msg: Message) {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_FROM) throw new Error("SMS is not configured.");
  const body = new URLSearchParams({ To: to, From: config.TWILIO_FROM, Body: `${msg.subject}\n${msg.text}`.slice(0, 1500) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Twilio answered ${res.status}`);
}

async function sendWebhook(url: string, msg: Message, payload: Record<string, unknown>) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !config.ALLOW_PRIVATE_NETWORK) throw new Error("Webhooks must use https.");
  if (!config.ALLOW_PRIVATE_NETWORK && (await isBlockedAddress(u.hostname))) throw new Error("Webhook points at a private address.");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "TestHarvest-Notifier/1" },
    body: JSON.stringify({ subject: msg.subject, text: msg.text, ...payload }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 300) throw new Error(`Webhook answered ${res.status}`);
}

/** Sends one message and records the outcome. Returns the final status. */
export async function deliver(opts: {
  channel: Channel;
  target: string;
  message: Message;
  kind: Kind;
  workspaceId?: number;
  ruleId?: number;
  incidentId?: number;
  executionId?: number;
  payload?: Record<string, unknown>;
}): Promise<"sent" | "failed" | "suppressed"> {
  const { channel, target, message, kind } = opts;
  let id: number | null = null;
  if (opts.workspaceId) {
    const [row] = await db
      .insert(notificationDeliveries)
      .values({
        workspaceId: opts.workspaceId,
        ruleId: opts.ruleId ?? null,
        incidentId: opts.incidentId ?? null,
        executionId: opts.executionId ?? null,
        channel,
        targetMasked: maskTarget(channel, target),
        kind,
        status: "pending",
      })
      .returning({ id: notificationDeliveries.id });
    id = row.id;
  }
  const finish = async (status: "sent" | "failed" | "suppressed", error?: string, attempts = 0) => {
    if (id !== null)
      await db
        .update(notificationDeliveries)
        .set({ status, error: error ?? null, attempts, sentAt: status === "sent" ? new Date() : null })
        .where(eq(notificationDeliveries.id, id));
    return status;
  };

  if (!config.NOTIFICATIONS_ENABLED) return finish("suppressed", "Notifications are turned off (NOTIFICATIONS_ENABLED).");

  // Up to three tries with backoff, for transient SMTP/HTTP failures.
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (channel === "email") await sendEmail(target, message);
      else if (channel === "sms") await sendSms(target, message);
      else await sendWebhook(target, message, opts.payload ?? {});
      return finish("sent", undefined, attempt);
    } catch (err) {
      lastError = (err as Error).message;
      log.warn("notification send failed", { channel, kind, attempt, ...errorFields(err) });
      if (/not configured|must use https|private address/.test(lastError)) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  return finish("failed", lastError.slice(0, 500), 3);
}
