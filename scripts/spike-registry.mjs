// Read-only capability spike against the hosted Concordium Agent Registry MCP.
// Makes NO writes, holds NO keys. Output is observed behaviour, to be copied into docs/integration-research.md.
const URL_MCP = process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp";
const NETWORKS = (process.env.SPIKE_NETWORKS ?? "testnet,mainnet").split(",");
let sessionId;
let id = 0;

async function rpc(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL_MCP, {
    method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  sessionId ??= res.headers.get("mcp-session-id") ?? undefined;
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const body = dataLine ? dataLine.slice(5).trim() : text;
  try { return { status: res.status, json: JSON.parse(body) }; } catch { return { status: res.status, raw: body.slice(0, 500) }; }
}

const out = { checkedAt: new Date().toISOString(), url: URL_MCP };
try {
  out.initialize = await rpc("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "supplypiper-spike", version: "0.0.0" },
  });
  await fetch(URL_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const list = await rpc("tools/list", {});
  out.toolNames = list.json?.result?.tools?.map((t) => t.name) ?? list;
  out.byNetwork = {};
  for (const network of NETWORKS) {
    out.byNetwork[network] = {};
    for (const tool of ["agent_registry_capabilities", "network_status", "contract_info"]) {
      const r = await rpc("tools/call", { name: tool, arguments: { network } });
      out.byNetwork[network][tool] = r.json?.result ?? r.json?.error ?? r;
    }
  }
} catch (e) {
  out.error = String(e?.message ?? e);
}
console.log(JSON.stringify(out, null, 2));
