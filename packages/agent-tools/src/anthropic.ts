import Anthropic from "@anthropic-ai/sdk";
import { ProviderUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider";

export interface AnthropicProviderOptions {
  apiKey: string; model: string; timeoutMs?: number;
  /**
   * Server-side refusal fallback (beta). Anthropic's guidance is to opt in by default for the newest models; it is OFF here
   * because it could not be exercised without live credentials. A wrong shape would only make the assistant report "unavailable".
   */
  refusalFallback?: boolean;
}

/**
 * Claude via the official SDK. Notes that follow the current API for the newest models:
 *  - thinking is always on (we send no `thinking` field); depth is controlled with output_config.effort
 *  - forced tool_choice is rejected (400), so we use `auto` with strict tool schemas and steer from the prompt
 *  - always check stop_reason for "refusal" before reading content
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  constructor(private readonly o: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: o.apiKey, timeout: o.timeoutMs ?? 30_000, maxRetries: 1 });
  }
  get model() { return this.o.model; }

  async complete(req: LlmRequest, opts?: { signal?: AbortSignal }): Promise<LlmResponse> {
    const body = {
      model: this.o.model, max_tokens: req.maxTokens, system: req.system,
      messages: req.messages as unknown as Anthropic.MessageParam[],
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, strict: true })) as unknown as Anthropic.Tool[], tool_choice: { type: "auto" as const } } : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    };
    let res: Anthropic.Message;
    try {
      res = this.o.refusalFallback
        ? ((await this.client.beta.messages.create({ ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never, { signal: opts?.signal })) as unknown as Anthropic.Message)
        : await this.client.messages.create(body as never, { signal: opts?.signal }) as Anthropic.Message;
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new ProviderUnavailable("rate limited", "RATE_LIMITED");
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderUnavailable("timed out", "TIMEOUT");
      if (e instanceof Anthropic.APIConnectionError) throw new ProviderUnavailable("connection failed", "OUTAGE");
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.BadRequestError) {
        throw new ProviderUnavailable(`provider rejected the request (${(e as { status?: number }).status})`, "MISCONFIGURED");
      }
      if (e instanceof Anthropic.APIError) throw new ProviderUnavailable(`provider error (${e.status})`, "OUTAGE");
      throw e;
    }
    const content: LlmResponse["content"] = [];
    for (const b of res.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      // thinking blocks are never surfaced or stored
    }
    const sr = res.stop_reason as string | null;
    return {
      content, model: res.model,
      stopReason: sr === "end_turn" || sr === "tool_use" || sr === "max_tokens" || sr === "refusal" ? sr : "other",
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}
