import type { PrismaClient, User } from "@prisma/client";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { audit, clientIp, enqueueEmail, validate } from "./helpers";
import { hashPassword, parseCookies, randomToken, safeEqual, sha256Base64, verifyPassword } from "./security";

export const SESSION_COOKIE = "sp_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000; // absolute lifetime; no sliding extension
const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export interface AuthContext { sessionId: string; csrfToken: string; user: User }
export const getAuth = (res: Response): AuthContext => res.locals.auth as AuthContext;

const password = z.string().min(12, "Use at least 12 characters").max(200);
const email = z.string().trim().toLowerCase().email().max(254);

/** Blocks cross-site form posts and non-JSON bodies on every state-changing request. */
export function requestGuards(config: AppConfig, allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.header("origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.header("host") && !allowedOrigins.includes(origin)) {
        return next(new ApiError(403, "ORIGIN_NOT_ALLOWED", "Cross-origin request blocked"));
      }
    }
    if (req.header("content-length") !== "0" && req.header("content-type")?.split(";")[0] !== "application/json") {
      return next(new ApiError(415, "JSON_REQUIRED", "Send application/json"));
    }
    void config;
    next();
  };
}

export function sessionLoader(prisma: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const token = parseCookies(req.header("cookie"))[SESSION_COOKIE];
    if (token) {
      const s = await prisma.session.findUnique({ where: { tokenHash: sha256Base64(token) }, include: { user: true } });
      if (s && !s.revokedAt && s.expiresAt > new Date() && !s.user.deletedAt) {
        res.locals.auth = { sessionId: s.id, csrfToken: s.csrfToken, user: s.user } satisfies AuthContext;
      }
    }
    next();
  };
}

export const requireSession: RequestHandler = (req, res, next) => {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) return next(new ApiError(401, "SESSION_REQUIRED", "Please sign in again"));
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const sent = req.header("x-csrf-token") ?? "";
    if (!sent || !safeEqual(sent, auth.csrfToken)) return next(new ApiError(403, "CSRF_INVALID", "Missing or invalid CSRF token"));
  }
  next();
};

export function authRouter(prisma: PrismaClient, config: AppConfig): Router {
  const r = Router();
  const secure = config.mode !== "demo";

  r.post("/register", async (req, res) => {
    const body = validate(z.object({ email, password, displayName: z.string().trim().min(1).max(100) }), req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (!existing) {
      const passwordHash = await hashPassword(body.password);
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: body.email, passwordHash, displayName: body.displayName } });
        const token = randomToken();
        await tx.authToken.create({ data: { userId: user.id, kind: "email_verify", tokenHash: sha256Base64(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
        await enqueueEmail(tx, user.email, "verify_email", { token });
        await audit(tx, res, { actorUserId: user.id, event: "user.registered", objectType: "User", objectId: user.id });
      });
    }
    // Same response whether or not the address exists (no account enumeration).
    res.status(202).json({ status: "verification_sent" });
  });

  r.post("/verify-email", async (req, res) => {
    const { token } = validate(z.object({ token: z.string().min(10).max(200) }), req.body);
    const ok = await prisma.$transaction(async (tx) => {
      const t = await tx.authToken.findUnique({ where: { tokenHash: sha256Base64(token) } });
      if (!t || t.kind !== "email_verify" || t.usedAt || t.expiresAt < new Date()) return false;
      const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: t.userId }, data: { emailVerified: new Date() } });
      await audit(tx, res, { actorUserId: t.userId, event: "user.email_verified", objectType: "User", objectId: t.userId });
      return true;
    });
    if (!ok) throw new ApiError(400, "TOKEN_INVALID", "This link is invalid, expired or already used");
    res.json({ status: "verified" });
  });

  r.post("/login", async (req, res) => {
    const body = validate(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const ip = clientIp(req);
    const since = new Date(Date.now() - LOGIN_WINDOW_MS);
    const [byEmail, byIp] = await Promise.all([
      prisma.loginAttempt.count({ where: { email: body.email, success: false, createdAt: { gte: since } } }),
      prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: since } } }),
    ]);
    if (byEmail >= MAX_FAILS_PER_EMAIL || byIp >= MAX_FAILS_PER_IP) {
      throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again in 15 minutes.");
    }
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const good = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || user.deletedAt || !good) {
      await prisma.loginAttempt.create({ data: { email: body.email, ip, success: false } });
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    if (!user.emailVerified) throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Verify your email before signing in");
    const token = randomToken();
    const csrfToken = randomToken(24);
    await prisma.$transaction(async (tx) => {
      await tx.loginAttempt.create({ data: { email: body.email, ip, success: true } });
      const s = await tx.session.create({ data: { userId: user.id, tokenHash: sha256Base64(token), csrfToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
      await audit(tx, res, { actorUserId: user.id, event: "session.created", objectType: "Session", objectId: s.id });
    });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_TTL_MS });
    res.json({ csrfToken, user: { id: user.id, email: user.email, displayName: user.displayName } });
  });

  r.get("/me", requireSession, (_req, res) => {
    const a = getAuth(res);
    res.json({ csrfToken: a.csrfToken, user: { id: a.user.id, email: a.user.email, displayName: a.user.displayName, timezone: a.user.timezone } });
  });

  r.post("/logout", requireSession, async (_req, res) => {
    const a = getAuth(res);
    await prisma.session.update({ where: { id: a.sessionId }, data: { revokedAt: new Date() } });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  r.post("/password-reset/request", async (req, res) => {
    const body = validate(z.object({ email }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && !user.deletedAt) {
      await prisma.$transaction(async (tx) => {
        const token = randomToken();
        await tx.authToken.create({ data: { userId: user.id, kind: "password_reset", tokenHash: sha256Base64(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
        await enqueueEmail(tx, user.email, "password_reset", { token });
        await audit(tx, res, { actorUserId: user.id, event: "password_reset.requested", objectType: "User", objectId: user.id });
      });
    }
    res.status(202).json({ status: "reset_sent_if_account_exists" });
  });

  r.post("/password-reset/confirm", async (req, res) => {
    const body = validate(z.object({ token: z.string().min(10).max(200), password }), req.body);
    const passwordHash = await hashPassword(body.password);
    const ok = await prisma.$transaction(async (tx) => {
      const t = await tx.authToken.findUnique({ where: { tokenHash: sha256Base64(body.token) } });
      if (!t || t.kind !== "password_reset" || t.usedAt || t.expiresAt < new Date()) return false;
      const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: t.userId }, data: { passwordHash, emailVerified: new Date() } });
      // Revocation policy: a password reset signs the user out everywhere.
      await tx.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, res, { actorUserId: t.userId, event: "password_reset.completed", objectType: "User", objectId: t.userId });
      return true;
    });
    if (!ok) throw new ApiError(400, "TOKEN_INVALID", "This link is invalid, expired or already used");
    res.json({ status: "password_changed" });
  });

  return r;
}

export type { NextFunction, Request };
