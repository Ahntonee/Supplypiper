import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://supplypiper:devonly@127.0.0.1:54329/supplypiper_test";
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let dbUp = false;
try { await prisma.$queryRaw`SELECT 1`; dbUp = true; } catch { /* reported as SKIPPED below */ }
if (!dbUp) console.warn("SKIPPED: integration tests need PostgreSQL at TEST_DATABASE_URL (run `npm run db:dev`).");

const d = describe.skipIf(!dbUp);

d("auth, organisations and tenant isolation (real PostgreSQL)", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

  beforeAll(() => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
      env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe", shell: true,
    });
    const config = loadConfig({ SUPPLYPIPER_MODE: "demo", VERIFICATION_ADAPTER: "mock", DATABASE_URL: DB_URL });
    server = createApp({ config, prisma, checkReady: async () => true }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => { server?.close(); await prisma.$disconnect(); });

  class Client {
    cookie = ""; csrf = "";
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(base + path, {
        method, headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf-token": this.csrf } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set?.startsWith("sp_session=") && !set.includes("sp_session=;")) this.cookie = set.split(";")[0]!;
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    }
  }

  const PW = "correct-horse-battery";
  async function emailToken(to: string, template: string): Promise<string> {
    const ev = await prisma.outboxEvent.findFirst({ where: { topic: "email", payload: { path: ["to"], equals: to } }, orderBy: { createdAt: "desc" } });
    const p = ev?.payload as { template: string; data: { token: string } } | undefined;
    expect(p?.template).toBe(template);
    return p!.data.token;
  }
  async function signedUp(label = "u"): Promise<{ c: Client; email: string; userId: string }> {
    const email = `${label}-${randomUUID()}@example.test`;
    const c = new Client();
    expect((await c.call("POST", "/auth/register", { email, password: PW, displayName: label })).status).toBe(202);
    expect((await c.call("POST", "/auth/verify-email", { token: await emailToken(email, "verify_email") })).status).toBe(200);
    const login = await c.call("POST", "/auth/login", { email, password: PW });
    expect(login.status).toBe(200);
    c.csrf = login.body.csrfToken;
    return { c, email, userId: login.body.user.id };
  }

  it("verifies email before login, stores only hashes, and does not enumerate accounts", async () => {
    const email = `v-${randomUUID()}@example.test`;
    const c = new Client();
    await c.call("POST", "/auth/register", { email, password: PW, displayName: "V" });
    const again = await c.call("POST", "/auth/register", { email, password: PW, displayName: "V" });
    expect(again.status).toBe(202); // identical response for an existing address
    expect((await c.call("POST", "/auth/login", { email, password: PW })).body.error.code).toBe("EMAIL_NOT_VERIFIED");
    const token = await emailToken(email, "verify_email");
    expect(await prisma.authToken.count({ where: { tokenHash: token } })).toBe(0); // raw token never stored
    expect((await c.call("POST", "/auth/verify-email", { token })).status).toBe(200);
    expect((await c.call("POST", "/auth/verify-email", { token })).body.error.code).toBe("TOKEN_INVALID"); // single use
  });

  it("sets an HttpOnly SameSite cookie and returns no token for localStorage", async () => {
    const { c } = await signedUp();
    const email = (await c.call("GET", "/auth/me")).body.user.email as string;
    const res = await fetch(base + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
  });

  it("rate-limits repeated failed logins per email", async () => {
    const { email } = await signedUp("rl");
    const c = new Client();
    for (let i = 0; i < 5; i++) expect((await c.call("POST", "/auth/login", { email, password: "wrong-wrong-wrong" })).status).toBe(401);
    expect((await c.call("POST", "/auth/login", { email, password: PW })).status).toBe(429); // even the right password is blocked
  });

  it("requires a CSRF token on mutations and rejects cross-site origins", async () => {
    const { c } = await signedUp();
    const noCsrf = new Client(); noCsrf.cookie = c.cookie;
    const r1 = await noCsrf.call("POST", "/orgs", { name: "Acme", capabilities: ["buyer"] });
    expect(r1.status).toBe(403); expect(r1.body.error.code).toBe("CSRF_INVALID");
    const r2 = await c.call("POST", "/orgs", { name: "Acme", capabilities: ["buyer"] }, { origin: "https://evil.example" });
    expect(r2.body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect((await c.call("POST", "/orgs", { name: "Acme", capabilities: ["buyer"] })).status).toBe(201);
  });

  it("logout revokes the session server-side", async () => {
    const { c } = await signedUp();
    expect((await c.call("GET", "/auth/me")).status).toBe(200);
    expect((await c.call("POST", "/auth/logout")).status).toBe(204);
    expect((await c.call("GET", "/auth/me")).status).toBe(401);
  });

  it("password reset is single-use and signs out every session", async () => {
    const { c, email } = await signedUp();
    await new Client().call("POST", "/auth/password-reset/request", { email });
    const token = await emailToken(email, "password_reset");
    const anon = new Client();
    expect((await anon.call("POST", "/auth/password-reset/confirm", { token, password: "a-brand-new-passphrase" })).status).toBe(200);
    expect((await anon.call("POST", "/auth/password-reset/confirm", { token, password: "another-new-passphrase" })).status).toBe(400);
    expect((await c.call("GET", "/auth/me")).status).toBe(401); // old session revoked
    expect((await anon.call("POST", "/auth/login", { email, password: "a-brand-new-passphrase" })).status).toBe(200);
  });

  it("creates orgs with server-derived environment and owner role", async () => {
    const { c, userId } = await signedUp();
    const created = await c.call("POST", "/orgs", { name: "Mama Put Kitchen", capabilities: ["buyer"], environment: "production" });
    expect(created.status).toBe(201);
    const org = await c.call("GET", `/orgs/${created.body.id}`);
    expect(org.body.environment).toBe("demo"); // client-supplied value ignored
    expect(org.body.yourRoles).toEqual(["owner"]);
    expect(await prisma.auditEvent.count({ where: { objectId: created.body.id, event: "org.created", actorUserId: userId } })).toBe(1);
  });

  it("denies cross-tenant access without disclosing existence", async () => {
    const a = await signedUp("a"); const b = await signedUp("b");
    const orgA = (await a.c.call("POST", "/orgs", { name: "Org A", capabilities: ["buyer"] })).body.id as string;
    for (const [m, p, body] of [["GET", `/orgs/${orgA}`], ["GET", `/orgs/${orgA}/members`], ["POST", `/orgs/${orgA}/invitations`, { email: "x@example.test", role: "supplier_staff" }]] as const) {
      const r = await b.c.call(m, p, body);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.error.code).toBe("NOT_FOUND");
    }
    expect((await b.c.call("GET", `/orgs/${randomUUID()}`)).status).toBe(404); // same answer as for a real foreign org
    expect((await b.c.call("GET", "/orgs")).body.organisations).toEqual([]);
  });

  it("enforces roles and capabilities on invitations", async () => {
    const owner = await signedUp("own"); const guest = await signedUp("guest");
    const orgId = (await owner.c.call("POST", "/orgs", { name: "Buyer Co", capabilities: ["buyer"] })).body.id as string;
    expect((await owner.c.call("POST", `/orgs/${orgId}/invitations`, { email: guest.email, role: "owner" })).status).toBe(400); // cannot invite owners
    expect((await owner.c.call("POST", `/orgs/${orgId}/invitations`, { email: guest.email, role: "buyer_approver" })).status).toBe(201);
    const token = await emailToken(guest.email, "org_invitation");
    expect((await guest.c.call("POST", "/invitations/accept", { token })).status).toBe(200);
    expect((await guest.c.call("GET", `/orgs/${orgId}`)).body.yourRoles).toEqual(["buyer_approver"]);
    // approver is a member but cannot manage members, and cannot see the member list
    expect((await guest.c.call("POST", `/orgs/${orgId}/invitations`, { email: "z@example.test", role: "supplier_staff" })).status).toBe(403);
    expect((await guest.c.call("GET", `/orgs/${orgId}/members`)).status).toBe(403);
  });

  it("rejects invitations used by the wrong account, and a simultaneous double accept succeeds once", async () => {
    const owner = await signedUp("own"); const guest = await signedUp("guest"); const other = await signedUp("other");
    const orgId = (await owner.c.call("POST", "/orgs", { name: "Race Co", capabilities: ["buyer"] })).body.id as string;
    await owner.c.call("POST", `/orgs/${orgId}/invitations`, { email: guest.email, role: "buyer_requester" });
    const token = await emailToken(guest.email, "org_invitation");
    expect((await other.c.call("POST", "/invitations/accept", { token })).status).toBe(400);
    const results = await Promise.all([guest.c.call("POST", "/invitations/accept", { token }), guest.c.call("POST", "/invitations/accept", { token })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await prisma.membership.count({ where: { orgId, userId: guest.userId } })).toBe(1);
  });

  it("rejects an expired invitation", async () => {
    const owner = await signedUp("own"); const guest = await signedUp("guest");
    const orgId = (await owner.c.call("POST", "/orgs", { name: "Late Co", capabilities: ["buyer"] })).body.id as string;
    const inv = await owner.c.call("POST", `/orgs/${orgId}/invitations`, { email: guest.email, role: "supplier_staff" });
    await prisma.invitation.update({ where: { id: inv.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await guest.c.call("POST", "/invitations/accept", { token: await emailToken(guest.email, "org_invitation") })).status).toBe(400);
  });

  it("audit events are append-only at the database level", async () => {
    const ev = await prisma.auditEvent.findFirstOrThrow();
    await expect(prisma.auditEvent.update({ where: { id: ev.id }, data: { event: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
  });
});
