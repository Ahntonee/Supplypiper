import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getAuth, requireSession } from "./auth";
import { ApiError } from "./errors";
import { validate } from "./helpers";

/** In-app notifications belong to one user. Every query is scoped by the session's user id, never by a client-supplied id alone. */
export function notificationsRouter(prisma: PrismaClient): Router {
  const r = Router();
  r.use(requireSession);

  r.get("/notifications", async (_req, res) => {
    const userId = getAuth(res).user.id;
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    res.json({ unread, notifications: rows.map((n) => ({ id: n.id, orgId: n.orgId, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.readAt !== null, createdAt: n.createdAt })) });
  });

  r.get("/notifications/unread-count", async (_req, res) => {
    res.json({ unread: await prisma.notification.count({ where: { userId: getAuth(res).user.id, readAt: null } }) });
  });

  const idParam = z.object({ id: z.string().uuid() });
  r.post("/notifications/:id/read", async (req, res) => {
    const { id } = validate(idParam, req.params);
    const done = await prisma.notification.updateMany({ where: { id, userId: getAuth(res).user.id, readAt: null }, data: { readAt: new Date() } });
    if (done.count === 0 && !(await prisma.notification.findFirst({ where: { id, userId: getAuth(res).user.id } }))) throw new ApiError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true });
  });

  r.post("/notifications/read-all", async (_req, res) => {
    const done = await prisma.notification.updateMany({ where: { userId: getAuth(res).user.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ marked: done.count });
  });

  return r;
}
