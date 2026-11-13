import { PrismaClient } from "@prisma/client";
import { AnthropicProvider } from "@supplypiper/agent-tools";
import { createGrpcAccountProvider, createHardenedCardFetcher, createMcpClient, DemoVerifier, RegistryVerifier } from "@supplypiper/concordium";
import { createAssistantService, recoverStaleRuns } from "./assistant";
import { createApp } from "./app";
import { createVerificationService } from "./agentVerification";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Demo mode only: a simulated verifier that labels every result as simulated. Testnet and production use the real registry, with no fallback.
const simulated = config.verificationAdapter === "mock";
const verifier = simulated
  ? new DemoVerifier()
  : new RegistryVerifier({ client: createMcpClient({ url: process.env.REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp" }), cardFetcher: createHardenedCardFetcher() });
const verification = createVerificationService({ prisma, verifier, freshnessMs: config.verificationFreshnessMs, sourceLabel: simulated ? "demo-simulated" : "concordium-agent-registry" });
const accountProvider = await createGrpcAccountProvider();

// AI is optional. With no provider configured every AI feature reports "unavailable"; there is no canned fallback dressed up as AI.
const provider = config.ai.provider === "anthropic" && config.ai.apiKey
  ? new AnthropicProvider({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: config.ai.timeoutMs, refusalFallback: config.ai.refusalFallback })
  : null;
const assistant = createAssistantService({ prisma, provider, ai: config.ai });
// Runs left mid-flight by a previous process are closed, not left hanging.
const recovered = await recoverStaleRuns(prisma, config.ai.timeoutMs * 2);

const app = createApp({
  config, prisma, allowedOrigins, verification, accountProvider, assistant, audience: process.env.PUBLIC_ORIGIN ?? "localhost",
  checkReady: async () => { await prisma.$queryRaw`SELECT 1`; return true; },
});
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.listen(config.port, () => {
  console.log(JSON.stringify({ level: "info", message: "SupplyPiper API listening", port: config.port, mode: config.mode, verification: simulated ? "simulated (demo only)" : "concordium-agent-registry", ai: provider ? `${provider.name} (${provider.model})` : "unavailable (no provider configured)", recoveredRuns: recovered }));
});
