import type { PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";

export interface OutgoingEmail { to: string; subject: string; text: string; html: string; /** The outbox event id. Stable across retries, so a provider (or the recipient) can recognise a duplicate. */ idempotencyKey: string }
export interface EmailProvider { readonly name: string; readonly kind: "dev" | "smtp"; send(e: OutgoingEmail): Promise<{ providerMessageId: string }> }

/** Retrying will not help (bad recipient, rejected message). The event is dead-lettered. */
export class PermanentSendError extends Error { constructor(message: string) { super(message); this.name = "PermanentSendError"; } }
/** Worth retrying later (network, timeout, 4xx from the server). */
export class TransientSendError extends Error { constructor(message: string) { super(message); this.name = "TransientSendError"; } }

/**
 * Development provider: "delivers" by storing the rendered message in our own database. Nothing leaves the machine, so no real address
 * can ever receive mail from a development or demo environment. Idempotent per outbox event.
 */
export class DevInboxProvider implements EmailProvider {
  readonly name = "dev-inbox"; readonly kind = "dev" as const;
  constructor(private readonly prisma: PrismaClient) {}
  async send(e: OutgoingEmail) {
    await this.prisma.sentEmail.upsert({ where: { outboxId: e.idempotencyKey }, create: { outboxId: e.idempotencyKey, to: e.to, subject: e.subject, text: e.text, html: e.html }, update: {} });
    return { providerMessageId: `dev:${e.idempotencyKey}` };
  }
}

const TRANSIENT_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "ETIMEOUT", "EAI_AGAIN", "ENOTFOUND"]);

/** Real delivery over SMTP. The Message-ID is derived from the outbox id, so a crash between send and bookkeeping can only cause a recognisable duplicate. */
export class SmtpProvider implements EmailProvider {
  readonly name = "smtp"; readonly kind = "smtp" as const;
  private readonly transport; private readonly domain;
  constructor(o: { url: string; from: string }, private readonly from = o.from) {
    this.domain = o.from.split("@")[1]!;
    this.transport = nodemailer.createTransport({ url: o.url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 } as unknown as Parameters<typeof nodemailer.createTransport>[0]);
  }
  async send(e: OutgoingEmail) {
    try {
      const info = await this.transport.sendMail({
        from: this.from, to: e.to, subject: e.subject, text: e.text, html: e.html, messageId: `<${e.idempotencyKey}@${this.domain}>`,
        headers: { "X-SupplyPiper-Idempotency-Key": e.idempotencyKey, "Auto-Submitted": "auto-generated" },
      });
      if (info.rejected?.length) throw new PermanentSendError("recipient rejected");
      return { providerMessageId: info.messageId };
    } catch (err) {
      if (err instanceof PermanentSendError) throw err;
      const x = err as { responseCode?: number; code?: string; message?: string };
      if (typeof x.responseCode === "number") {
        if (x.responseCode >= 500) throw new PermanentSendError(`smtp ${x.responseCode}`);
        throw new TransientSendError(`smtp ${x.responseCode}`);
      }
      if (x.code && TRANSIENT_CODES.has(x.code)) throw new TransientSendError(`network ${x.code}`);
      throw new TransientSendError(`send failed (${x.code ?? "unknown"})`);
    }
  }
  close() { this.transport.close(); }
}
