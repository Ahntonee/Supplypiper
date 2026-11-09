// Local-only PostgreSQL (real PG binaries via embedded-postgres). NOT for production.
// Usage: node scripts/dev-db.mjs [start|init]   (start keeps running until Ctrl+C)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const dir = new URL("../.pgdata", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "supplypiper", password: "devonly", port, persistent: true });

if (!existsSync(dir + "/PG_VERSION")) await pg.initialise();
await pg.start();
for (const db of ["supplypiper_dev", "supplypiper_test"]) {
  try { await pg.createDatabase(db); } catch (e) { if (!/already exists/.test(String(e))) throw e; }
}
console.log(`PostgreSQL ready on 127.0.0.1:${port} (dbs: supplypiper_dev, supplypiper_test)`);
if (process.argv[2] === "init") { await pg.stop(); process.exit(0); }
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
