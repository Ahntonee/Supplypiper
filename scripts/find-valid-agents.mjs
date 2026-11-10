// Read-only: scan real registry agents for ones whose card fetches, hashes to the on-chain anchor, and carries a valid badge.
// Used once to capture a real positive fixture and to give the live smoke test known-good inputs.
// Usage: node scripts/find-valid-agents.mjs [testnet|mainnet] [maxToScan]
import { writeFileSync } from "node:fs";

const URL_MCP = process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp";
const network = process.argv[2] ?? "testnet";
const MAX = Number(process.argv[3] ?? 300);
let sessionId; let id = 0;
async function rpc(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
  const res = await fetch(URL_MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(30_000) });
  sessionId ??= res.headers.get("mcp-session-id") ?? undefined;
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5).trim() : text);
}
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: { network, ...args } });
  const text = r.result?.content?.[0]?.text; let v = text; try { v = JSON.parse(text); } catch { /* text error */ }
  return { isError: !!r.result?.isError, value: v };
}
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "supplypiper-probe", version: "0.0.0" } });
await fetch(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const reg = (await tool("contract_info", {})).value.cis8004_contract;
const found = []; let scanned = 0; const tallies = { badge_valid: 0, card_fetched: 0, hash_matches: 0, active: 0 };
for (let offset = 0; offset < MAX && found.length < 3; offset += 50) {
  const page = (await tool("list_agents", { limit: 50, offset, status: "Active" })).value?.agents ?? [];
  if (!page.length) break;
  for (let i = 0; i < page.length && found.length < 3; i += 5) {
    const batch = page.slice(i, i + 5);
    const res = await Promise.all(batch.map(async (a) => {
      const addr = (await tool("token_address", { contract_index: reg.index, contract_subindex: reg.subindex, token_id: a.token_id })).value?.token_address;
      const badge = addr ? (await tool("check_badge", { id: addr })).value : null;
      return { a, addr, badge };
    }));
    for (const r of res) {
      scanned++;
      const c = r.badge?.checks ?? {};
      if (c.status_active) tallies.active++; if (c.card_fetched) tallies.card_fetched++; if (c.hash_matches_on_chain) tallies.hash_matches++; if (r.badge?.badge_valid) tallies.badge_valid++;
      if (r.badge?.badge_valid) found.push({ agent: r.a, tokenAddress: r.addr, checkBadge: r.badge });
    }
  }
}
writeFileSync(new URL(`../docs/registry-valid-agents-${network}.json`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({ checkedAt: new Date().toISOString(), network, scanned, tallies, found }, null, 2));
console.log(JSON.stringify({ network, scanned, tallies, validFound: found.length, tokenAddresses: found.map((f) => f.tokenAddress) }));
