/** Provider-neutral model interface. Credentials live only inside a provider implementation on the server. */
export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export interface LlmMessage { role: "user" | "assistant"; content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock> }

export interface LlmToolSpec { name: string; description: string; input_schema: Record<string, unknown> }
export interface LlmRequest { system: string; messages: LlmMessage[]; tools: LlmToolSpec[]; maxTokens: number; effort?: "low" | "medium" | "high" }
export interface LlmUsage { inputTokens: number; outputTokens: number }
export interface LlmResponse {
  content: Array<TextBlock | ToolUseBlock>;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage; model: string;
}

export interface LlmProvider {
  readonly name: string; readonly model: string;
  complete(req: LlmRequest, opts?: { signal?: AbortSignal }): Promise<LlmResponse>;
}

/** The provider is down, rate limited, timed out, or not configured. The product keeps working without it. */
export class ProviderUnavailable extends Error {
  constructor(message: string, public readonly reason: "NOT_CONFIGURED" | "OUTAGE" | "RATE_LIMITED" | "TIMEOUT" | "MISCONFIGURED" = "OUTAGE") { super(message); this.name = "ProviderUnavailable"; }
}

/** Integer micro-USD per million tokens (e.g. $4.00 per MTok is 4_000_000). Cost metering only; never customer money. */
export interface Pricing { inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number }
export const costMicroUsd = (u: LlmUsage, p: Pricing): number =>
  Math.ceil((u.inputTokens * p.inputMicroUsdPerMTok + u.outputTokens * p.outputMicroUsdPerMTok) / 1_000_000);
