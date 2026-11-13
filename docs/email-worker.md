# Email worker and notifications

What exists, what it guarantees, and what it does **not**.

## What was built
- **Transactional outbox.** API changes that need an email write an `OutboxEvent` in the same database transaction as the change (`enqueueEmail`). If the change rolls back, so does the email (tested).
- **Worker** (`apps/worker`, run with `npm run worker`): claims due events, renders the template, sends through a provider, records the outcome, retries with backoff, dead-letters what cannot succeed.
- **Providers.** `dev` (default) stores the rendered message in the database `SentEmail` table and shows it at `/dev/inbox`: nothing leaves the machine. `smtp` sends through any SMTP server via `SMTP_URL`. **No real email provider has been chosen, configured or exercised**; the SMTP adapter is tested only against a local SMTP test server.
- **In-app notifications.** Workflow events (`rfq_invited`, `order_created`, `order_accepted`) also create a `Notification` for the recipient in the same transaction. The bell in the header shows the unread count (polled every 30 s; there is no push channel) and `/app/notifications` lists them. Account emails (verify, reset, invitation) carry single-use tokens and are **never** turned into notifications.
- **Pages the emails link to:** `/verify`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/app/inbox/:id`, `/app/orders/:id`.

## Delivery guarantees (stated plainly)
- **At-least-once, not exactly-once.** An event is claimed with a lease using `FOR UPDATE SKIP LOCKED`, so two live workers never hold the same event. If a worker dies after the provider accepted a message but before it recorded that, the lease expires (default 2 minutes) and another worker sends it again. The Message-ID (`<outbox-id@sender-domain>`) and the `X-SupplyPiper-Idempotency-Key` header are derived from the outbox id, so a duplicate is recognisable; mail systems may or may not suppress it. The dev inbox is idempotent per event.
- **Fenced outcomes.** The final update only applies while the worker still holds the lease, so a slow worker cannot overwrite the new owner's result (tested).
- **Retry schedule.** Transient failure (network, timeout, SMTP 4xx): 30 s, 1 m, 2 m, 4 m ... capped at 1 h, with ±20% jitter. After `WORKER_MAX_ATTEMPTS` (default 8) the event is dead-lettered.
- **Dead-letter at once** for: SMTP 5xx or rejected recipient, unknown topic, unknown template, malformed payload or extra fields, recipient outside the allow-list.
- **No poison loops.** An unexpected exception in one event marks that event failed and processing continues.
- Stored errors are sanitised (tokens and addresses redacted, length-capped). Worker logs are JSON lines and never contain payloads or addresses.

## Safety gates before any real email
Starting in `EMAIL_MODE=smtp` is refused unless **all** hold: `SMTP_URL` set, valid `EMAIL_FROM`, `EMAIL_LIVE_APPROVED=true` (an explicit operator decision), and, outside production, `EMAIL_ALLOWED_DOMAINS` listing the pilot recipients' domains (anything else is suppressed before any provider is reached). `production` refuses the dev inbox. Demo and testnet emails are subject-prefixed `[Demo]` / `[Testnet]` and say so in the body.

Notification emails say that something happened and where to look. They carry no prices, budgets, addresses or business names; detail stays behind sign-in. Verifying an email address is described as not an identity check.

## Running it
```bash
npm run db:dev         # dev PostgreSQL
npm run dev:api        # API   (DEV_INBOX=true to use /dev/inbox)
npm run dev:web
npm run worker         # the worker
npm run worker:stats   # queue counts by state + heartbeat (no addresses or content)
npm run worker:dead    # dead-lettered events: id, template, attempts, sanitised error
npx tsx --env-file=.env apps/worker/src/admin.ts requeue <event id>   # after fixing the cause
```
Health: `GET /health/worker` returns 200 while the heartbeat is under 30 s old, otherwise 503 (`stale` / `no_worker_seen`), with queue counts and how long the oldest due event has waited. Alert on 503 or a growing `dead` count. **No alerting is wired up.**

Settings (`.env.example`): `EMAIL_MODE`, `EMAIL_FROM`, `SMTP_URL`, `EMAIL_LIVE_APPROVED`, `EMAIL_ALLOWED_DOMAINS`, `PUBLIC_BASE_URL` (links in emails), `WORKER_POLL_MS`, `WORKER_BATCH`, `WORKER_LEASE_MS`, `WORKER_MAX_ATTEMPTS`. Out-of-range values stop startup. Keep `WORKER_LEASE_MS` well above the longest send time (SMTP timeouts are 10/10/20 s).

## Operating notes
- Several workers can run at once. Stop one with SIGTERM/SIGINT: it finishes the current batch first.
- Dead events are never retried automatically. Fix the cause (config, template, address), then requeue. Requeue resets the attempt counter.
- `delivered` and `dead` rows are kept as an operational record. **No retention or purge policy exists yet**, and the `Notification` table is unbounded.
- Time columns hold UTC wall time (`timestamp`). Raw SQL here binds ISO strings cast to `::timestamp`; do not use bare `NOW()`.

## Not done
Real provider selection and account, SPF/DKIM/DMARC and sender-domain setup, bounce and complaint handling, unsubscribe and notification preferences, push or SMS channels, a metrics endpoint, alert routing, retention jobs, localisation of emails, and a second, independent delivery-verification test against a real mailbox.

## Tests
`apps/worker/src/worker.test.ts` (templates, backoff, error sanitising, config guards), `tests/integration/worker.test.ts` (real PostgreSQL: delivery, concurrent workers send each event once, retry then success, permanent failure, max attempts, poison events, allow-list suppression, lease recovery without stealing live locks, fenced updates, requeue, health endpoint; real local SMTP server: success with headers, 550 permanent, 451 and refused connection transient), `tests/integration/procurement.test.ts` (notifications created with the change, private per user, no tokens or prices, atomic rollback), and the browser journey `npm run e2e:worker` at 390/768/1440 (starts a real worker process; queue state shown before delivery; verify, forgot/reset, invitation signed out then in, bell, notice opens in the right organisation; axe clean).
