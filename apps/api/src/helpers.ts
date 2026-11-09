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
  await tx.outboxEvent.create({ data: { topic: "email", payload: { to, template, data } } });
}

export const clientIp = (req: Request): string => req.ip ?? "unknown";
