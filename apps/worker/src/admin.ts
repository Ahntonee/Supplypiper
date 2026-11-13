import { PrismaClient } from "@prisma/client";
import { backlog, requeueDead } from "./deliver";

/**
 * Operator commands for the email outbox. Output never includes recipient addresses or message content, only ids, template names,
 * attempt counts and sanitised error codes, so it is safe to paste into a ticket.
 *   stats                 queue counts by state and the worker heartbeat
 *   list-dead             dead-lettered events (newest first)
 *   requeue <event id>    put one dead event back in the queue after the cause is fixed
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const prisma = new PrismaClient({ datasources: { db: { url } } });
const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === "stats") {
    const beat = await prisma.workerHeartbeat.findUnique({ where: { name: "email-outbox" } });
    console.log(JSON.stringify({ queue: await backlog(prisma), worker: beat ? { lastBeatSecondsAgo: Math.round((Date.now() - beat.lastBeatAt.getTime()) / 1000), processed: beat.processed, failed: beat.failed } : "no worker has reported" }, null, 2));
  } else if (cmd === "list-dead") {
    const rows = await prisma.outboxEvent.findMany({ where: { state: "dead" }, orderBy: { createdAt: "desc" }, take: 50 });
    for (const r of rows) {
      const template = typeof r.payload === "object" && r.payload && "template" in r.payload ? String((r.payload as { template: unknown }).template).slice(0, 40) : "-";
      console.log(JSON.stringify({ id: r.id, topic: r.topic, template, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt }));
    }
    if (rows.length === 0) console.log("No dead-lettered events.");
  } else if (cmd === "requeue" && arg) {
    console.log((await requeueDead(prisma, arg)) ? `Requeued ${arg}` : `No dead event with id ${arg}`);
  } else {
    console.error("Usage: stats | list-dead | requeue <event id>");
    process.exitCode = 2;
  }
} finally { await prisma.$disconnect(); }
