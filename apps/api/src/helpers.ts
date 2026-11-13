import type { Prisma, PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "./errors";

export type Tx = Prisma.TransactionClient | PrismaClient;

export function validate<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details: Record<string, string> = {};
  for (const issue of r.error.issues) details[issue.path.join(".") || "_"] ??= issue.message;
  throw new ApiError(400, "VALIDATION_FAILED", "Some fields need attention", details);
}

export const correlationId = (res: Response): string => res.locals.correlationId as string;

export async function audit(
  tx: Tx,
  res: Response,
  e: { orgId?: string | null; actorUserId?: string | null; event: string; objectType: string; objectId: string; payload?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      orgId: e.orgId ?? null, actorUserId: e.actorUserId ?? null, event: e.event,
      objectType: e.objectType, objectId: e.objectId, correlationId: correlationId(res), payload: e.payload,
    },
  });
}

/** Transactional outbox: the notification is committed atomically with the state change. */
export async function enqueueEmail(tx: Tx, to: string, template: string, data: Record<string, string>): Promise<void> {
  const event = await tx.outboxEvent.create({ data: { topic: "email", payload: { to, template, data } } });
  // Workflow notifications also appear in the app, committed in the same transaction. Account emails (verify, reset, invite) never do: they carry single-use tokens.
  const n = NOTIFICATIONS[template];
  if (!n) return;
  const user = await tx.user.findUnique({ where: { email: to } });
  if (!user) return;
  await tx.notification.create({ data: { userId: user.id, orgId: data.orgId ?? null, kind: template, title: n.title, body: n.body, link: n.link(data), outboxId: event.id } });
}

const NOTIFICATIONS: Record<string, { title: string; body: string; link: (d: Record<string, string>) => string }> = {
  rfq_invited: { title: "New request to quote", body: "A buyer asked your business to quote. Open it to see the details and reply before the deadline.", link: (d) => `/app/inbox/${d.requestId}` },
  order_created: { title: "A buyer approved your quote", body: "An order was created from your quote. Accept or decline it.", link: (d) => `/app/orders/${d.orderId}` },
  order_accepted: { title: "A supplier accepted your order", body: "The supplier accepted. You confirm receipt yourself when the goods arrive.", link: (d) => `/app/orders/${d.orderId}` },
};

export const clientIp = (req: Request): string => req.ip ?? "unknown";
