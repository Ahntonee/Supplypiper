// Read-only probe of the hosted Concordium Agent Registry MCP: full tool schemas, then real agents on one network.
// No writes, no keys. Output (observed behaviour) is saved under docs/ and used to build test fixtures.
// Usage: node scripts/probe-registry.mjs [testnet|mainnet]
import { writeFileSync } from "node:fs";

const URL_MCP = process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp";
const network = process.argv[2] ?? "testnet";
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
  const text = r.result?.content?.[0]?.text;
  let parsed = text; try { parsed = JSON.parse(text); } catch { /* plain text error */ }
  return { isError: !!r.result?.isError, rpcError: r.error ?? null, value: parsed };
}

const out = { checkedAt: new Date().toISOString(), network, url: URL_MCP };
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "supplypiper-probe", version: "0.0.0" } });
await fetch(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const tools = (await rpc("tools/list", {})).result.tools;
out.toolSchemas = Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }]));

out.list_agents = await tool("list_agents", { limit: 5 });
const firstList = out.list_agents.value;
const agents = Array.isArray(firstList) ? firstList : firstList?.agents ?? firstList?.items ?? [];
out.sampleAgentCount = agents.length;
const sample = agents[0];
out.sampleAgent = sample ?? null;
const REGISTRY = JSON.parse((await tool("contract_info", {})).value?.cis8004_contract ? JSON.stringify((await tool("contract_info", {})).value.cis8004_contract) : "{}");
out.registry = REGISTRY;
const tokenId = sample?.token_id;
out.tokenId = tokenId ?? null;
if (tokenId !== undefined) {
  out.token_address = await tool("token_address", { contract_index: REGISTRY.index, contract_subindex: REGISTRY.subindex, token_id: tokenId });
  const tokenAddress = typeof out.token_address.value === "string" ? out.token_address.value : out.token_address.value?.token_address;
  out.tokenAddressUsed = tokenAddress ?? null;
  out.agent_of = await tool("agent_of", { token_id: tokenId });
  out.is_active = await tool("is_active", { token_id: tokenId });
  out.verify_agent_card = await tool("verify_agent_card", { token_id: tokenId });
  out.get_agent_wallet = await tool("get_agent_wallet", { token_id: tokenId });
  if (tokenAddress) {
    out.agent_by_token_address = await tool("agent_by_token_address", { token_address: tokenAddress });
    out.check_badge = await tool("check_badge", { id: tokenAddress });
    out.get_badge_json = await tool("get_badge_json", { token_address: tokenAddress });
  }
}
out.revoked = await tool("list_agents", { limit: 2, status: "Revoked" });
const rv = out.revoked.value?.agents?.[0];
if (rv) { out.revoked_agent_of = await tool("agent_of", { token_id: rv.token_id }); out.revoked_is_active = await tool("is_active", { token_id: rv.token_id }); out.revoked_verify_card = await tool("verify_agent_card", { token_id: rv.token_id }); }
out.unknown = { agent_of: await tool("agent_of", { token_id: "999999999999" }), is_active: await tool("is_active", { token_id: "999999999999" }), verify_agent_card: await tool("verify_agent_card", { token_id: "999999999999" }) };
out.badLookups = { malformedToken: await tool("agent_by_token_address", { token_address: "not-a-token" }), badTokenId: await tool("is_active", { token_id: "abc" }) };
writeFileSync(new URL(`../docs/registry-probe-${network}.json`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify(out, null, 2));
console.log('probe saved: docs/registry-probe-' + network + '.json');
