import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
// Readiness is false until the Prisma client is wired in (Stage 1, blocked on local PostgreSQL).
const app = createApp({ config, checkReady: async () => false });
app.listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", message: "SupplyPiper API listening", port: config.port, mode: config.mode }));
});
