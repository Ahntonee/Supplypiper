import { z } from "zod";

/** Raised for events that can never be rendered (unknown template, bad data). They go straight to the dead-letter state. */
export class UnrenderableError extends Error { constructor(message: string) { super(message); this.name = "UnrenderableError"; } }

export interface RenderContext { baseUrl: string; modeLabel: string }
export interface RenderedEmail { subject: string; text: string; html: string }

const token = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/);
const id = z.string().uuid();
const schemas = {
  verify_email: z.object({ token }).strict(),
  password_reset: z.object({ token }).strict(),
  org_invitation: z.object({ token, orgId: id.optional() }).strict(),
  rfq_invited: z.object({ requestId: id, orgId: id.optional() }).strict(),
  order_created: z.object({ orderId: id, orgId: id.optional() }).strict(),
  order_accepted: z.object({ orderId: id, orgId: id.optional() }).strict(),
} as const;
export type TemplateName = keyof typeof schemas;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Body { subject: string; lead: string; action: string; path: string; note: string }

/**
 * Notification emails say that something happened and where to look. They deliberately carry no prices, addresses, supplier or buyer
 * names and no quote contents: details stay behind sign-in. Only the two account emails contain a single-use link token.
 */
function body(name: TemplateName, d: Record<string, string | undefined>): Body {
  switch (name) {
    case "verify_email": return { subject: "Verify your email for SupplyPiper", lead: "Confirm that you control this email address so you can sign in to SupplyPiper.", action: "Verify email", path: `/verify?token=${encodeURIComponent(d.token!)}`, note: "This link works once and expires in 24 hours. Verifying an email address is not an identity check. If you didn't create an account, ignore this message." };
    case "password_reset": return { subject: "Reset your SupplyPiper password", lead: "Someone asked to reset the password for this account.", action: "Choose a new password", path: `/reset-password?token=${encodeURIComponent(d.token!)}`, note: "This link works once and expires in 30 minutes. If you didn't ask for this, ignore it: your password is unchanged. Resetting signs you out everywhere." };
    case "org_invitation": return { subject: "You have been invited to an organisation on SupplyPiper", lead: "You were invited to join an organisation. Sign in with this email address to accept.", action: "Accept the invitation", path: `/accept-invite?token=${encodeURIComponent(d.token!)}`, note: "This invitation works once and expires in 7 days." };
    case "rfq_invited": return { subject: "You have a new request to quote on SupplyPiper", lead: "A buyer has asked your business to quote. Open SupplyPiper to see the request and reply before its deadline.", action: "Open the request", path: `/app/inbox/${d.requestId}`, note: "Details are shown after you sign in, not in this email." };
    case "order_created": return { subject: "A buyer approved your quote on SupplyPiper", lead: "A buyer approved one of your quotes and created an order. It needs your response: accept or decline.", action: "Open the order", path: `/app/orders/${d.orderId}`, note: "Acceptance is your commitment to supply. It is not proof of delivery." };
    case "order_accepted": return { subject: "A supplier accepted your order on SupplyPiper", lead: "The supplier accepted your order. You will confirm receipt yourself when the goods arrive.", action: "Open the order", path: `/app/orders/${d.orderId}`, note: "Supplier acceptance does not prove delivery." };
  }
}

export function renderEmail(template: string, data: unknown, ctx: RenderContext): RenderedEmail {
  const schema = (schemas as Record<string, z.ZodType<Record<string, string | undefined>>>)[template];
  if (!schema) throw new UnrenderableError(`unknown template "${template.slice(0, 40)}"`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new UnrenderableError(`invalid data for template ${template}`);
  const b = body(template as TemplateName, parsed.data);
  const url = new URL(b.path, ctx.baseUrl + "/").toString();
  const subject = `${ctx.modeLabel}${b.subject}`;
  const envLine = ctx.modeLabel ? `\n${ctx.modeLabel.trim()} environment: this message is not from a production service.\n` : "";
  const text = `${b.lead}\n\n${b.action}: ${url}\n\n${b.note}\n${envLine}\nSupplyPiper pilot. This is a transactional message about your account or workflow.`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#F6F8F7;font-family:Arial,Helvetica,sans-serif;color:#142321"><div style="max-width:560px;margin:0 auto;padding:24px"><p style="font-weight:700;font-size:18px;margin:0 0 16px">SupplyPiper</p><div style="background:#fff;border:1px solid #DCE4E0;border-radius:12px;padding:24px"><p style="margin:0 0 16px;font-size:16px;line-height:1.5">${esc(b.lead)}</p><p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#145B50;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">${esc(b.action)}</a></p><p style="margin:0 0 8px;font-size:13px;color:#52625E;line-height:1.5">${esc(b.note)}</p><p style="margin:0;font-size:12px;color:#52625E;word-break:break-all">If the button doesn't work, copy this address: ${esc(url)}</p>${ctx.modeLabel ? `<p style="margin:12px 0 0;font-size:12px;color:#754C00">${esc(ctx.modeLabel.trim())} environment: not from a production service.</p>` : ""}</div><p style="font-size:12px;color:#52625E;margin:16px 0 0">SupplyPiper pilot. This is a transactional message about your account or workflow.</p></div></body></html>`;
  return { subject, text, html };
}

export const NOTIFIABLE: ReadonlySet<string> = new Set(["rfq_invited", "order_created", "order_accepted"]);
