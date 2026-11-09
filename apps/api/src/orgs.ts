import type { PrismaClient } from "@prisma/client";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { can, type OrgCapability, type OrgRole, type Permission } from "@supplypiper/domain";
import type { AppConfig } from "./config";
import { getAuth, requireSession } from "./auth";
import { ApiError } from "./errors";
import { audit, enqueueEmail, validate } from "./helpers";
import { randomToken, sha256Base64 } from "./security";

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const orgIdParam = z.string().uuid();

export interface OrgScope { orgId: string; roles: OrgRole[]; capabilities: OrgCapability[] }
export const getScope = (res: import("express").Response): OrgScope => res.locals.orgScope as OrgScope;

/**
 * Tenant scope comes from the SERVER's membership table, never from a browser-supplied tenant id alone.
 * Non-members get 404 so object existence is not disclosed across tenants.
 */
export function requireOrgPermission(prisma: PrismaClient, permission: Permission): RequestHandler {
  return async (req, res, next) => {
    const parsed = orgIdParam.safeParse(req.params.orgId);
    if (!parsed.success) return next(new ApiError(404, "NOT_FOUND", "Organisation not found"));
    const { user } = getAuth(res);
    const memberships = await prisma.membership.findMany({ where: { orgId: parsed.data, userId: user.id }, include: { org: true } });
    if (memberships.length === 0) return next(new ApiError(404, "NOT_FOUND", "Organisation not found"));
    const roles = memberships.map((m) => m.role as OrgRole);
    const capabilities = memberships[0]!.org.capabilities as OrgCapability[];
    if (!can(roles, capabilities, permission)) return next(new ApiError(403, "FORBIDDEN", "Your role cannot do this"));
    res.locals.orgScope = { orgId: parsed.data, roles, capabilities } satisfies OrgScope;
    next();
  };
}

export function orgRouter(prisma: PrismaClient, config: AppConfig): Router {
  const r = Router();
  r.use(requireSession);

  r.post("/orgs", async (req, res) => {
    const body = validate(z.object({
      name: z.string().trim().min(2).max(120),
      capabilities: z.array(z.enum(["buyer", "supplier"])).min(1).max(2),
      areaCode: z.string().trim().max(60).optional(),
    }), req.body);
    const { user } = getAuth(res);
    const org = await prisma.$transaction(async (tx) => {
      // environment is fixed by the server mode; a client can never create a "production" org in a demo build.
      const o = await tx.organisation.create({ data: { name: body.name, capabilities: [...new Set(body.capabilities)], areaCode: body.areaCode, environment: config.mode } });
      await tx.membership.create({ data: { orgId: o.id, userId: user.id, role: "owner" } });
      await audit(tx, res, { orgId: o.id, actorUserId: user.id, event: "org.created", objectType: "Organisation", objectId: o.id });
      return o;
    });
    res.status(201).json({ id: org.id, name: org.name, capabilities: org.capabilities });
  });

  r.get("/orgs", async (_req, res) => {
    const { user } = getAuth(res);
    const ms = await prisma.membership.findMany({ where: { userId: user.id }, include: { org: true } });
    const byOrg = new Map<string, { id: string; name: string; capabilities: string[]; roles: string[] }>();
    for (const m of ms) {
      const e = byOrg.get(m.orgId) ?? { id: m.orgId, name: m.org.name, capabilities: m.org.capabilities, roles: [] };
      e.roles.push(m.role);
      byOrg.set(m.orgId, e);
    }
    res.json({ organisations: [...byOrg.values()] });
  });

  r.get("/orgs/:orgId", requireOrgPermission(prisma, "order.view"), async (_req, res) => {
    const s = getScope(res);
    const o = await prisma.organisation.findUniqueOrThrow({ where: { id: s.orgId } });
    res.json({ id: o.id, name: o.name, capabilities: o.capabilities, areaCode: o.areaCode, environment: o.environment, yourRoles: s.roles });
  });

  r.get("/orgs/:orgId/members", requireOrgPermission(prisma, "org.view_members"), async (_req, res) => {
    const s = getScope(res);
    const ms = await prisma.membership.findMany({ where: { orgId: s.orgId }, include: { user: true } });
    res.json({ members: ms.map((m) => ({ userId: m.userId, displayName: m.user.displayName, email: m.user.email, role: m.role })) });
  });

  r.post("/orgs/:orgId/invitations", requireOrgPermission(prisma, "org.manage_members"), async (req, res) => {
    const body = validate(z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      role: z.enum(["buyer_requester", "buyer_approver", "supplier_manager", "supplier_staff", "read_only_auditor"]),
    }), req.body);
    const s = getScope(res);
    const { user } = getAuth(res);
    const inv = await prisma.$transaction(async (tx) => {
      const token = randomToken();
      const i = await tx.invitation.create({ data: { orgId: s.orgId, email: body.email, role: body.role, tokenHash: sha256Base64(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
      await enqueueEmail(tx, body.email, "org_invitation", { token, orgId: s.orgId });
      await audit(tx, res, { orgId: s.orgId, actorUserId: user.id, event: "invitation.created", objectType: "Invitation", objectId: i.id, payload: { role: body.role } });
      return i;
    });
    res.status(201).json({ id: inv.id, expiresAt: inv.expiresAt });
  });

  r.post("/invitations/accept", async (req, res) => {
    const { token } = validate(z.object({ token: z.string().min(10).max(200) }), req.body);
    const { user } = getAuth(res);
    const orgId = await prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.findUnique({ where: { tokenHash: sha256Base64(token) } });
      if (!inv || inv.acceptedAt || inv.expiresAt < new Date() || inv.email !== user.email || !user.emailVerified) return null;
      const claimed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) return null;
      await tx.membership.upsert({
        where: { orgId_userId_role: { orgId: inv.orgId, userId: user.id, role: inv.role } },
        create: { orgId: inv.orgId, userId: user.id, role: inv.role }, update: {},
      });
      await audit(tx, res, { orgId: inv.orgId, actorUserId: user.id, event: "invitation.accepted", objectType: "Invitation", objectId: inv.id });
      return inv.orgId;
    });
    if (!orgId) throw new ApiError(400, "INVITATION_INVALID", "This invitation is invalid, expired, already used, or for a different email");
    res.json({ orgId });
  });

  return r;
}
