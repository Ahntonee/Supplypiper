import { PrismaClient } from "@prisma/client";
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const app = createApp({
  config, prisma, allowedOrigins,
  checkReady: async () => { await prisma.$queryRaw`SELECT 1`; return true; },
});
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", message: "SupplyPiper API listening", port: config.port, mode: config.mode }));
});
