// Records REAL registry responses (read-only) as test fixtures for packages/concordium. Re-run to refresh.
// Cases: valid (token 43), revoked (11, whose on-chain agent_uri is a <script> tag), broken card (0, card URL 404s), unknown id.
import { writeFileSync } from "node:fs";

const URL_MCP = process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp";
const network = "testnet";
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
  const text = r.result?.content?.[0]?.text; let v = text; try { v = JSON.parse(text); } catch { /* text */ }
  return { isError: !!r.result?.isError, value: v };
}
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "supplypiper-fixtures", version: "0.0.0" } });
await fetch(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const out = { capturedAt: new Date().toISOString(), network, note: "Real responses from the hosted registry MCP (agent_of). Not hand-written." };
for (const [label, tokenId] of [["valid", "43"], ["revoked", "11"], ["brokenCard", "0"], ["unknown", "999999999999"]]) out[label] = (await tool("agent_of", { token_id: tokenId })).value;
const brokenUri = out.brokenCard?.agent_uri;
if (brokenUri) {
  const r = await fetch(brokenUri, { signal: AbortSignal.timeout(15_000) });
  const bytes = Buffer.from(await r.arrayBuffer());
  out.brokenCardResponse = { status: r.status, bodyUtf8: bytes.toString("utf8") };
}
writeFileSync(new URL("../packages/concordium/fixtures/agent_of.testnet.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ valid: out.valid?.status, revoked: out.revoked?.status, brokenCard: out.brokenCardResponse?.status, unknown: out.unknown }));
