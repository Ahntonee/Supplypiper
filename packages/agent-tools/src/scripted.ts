import { ProviderUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider";

/**
 * TEST-ONLY provider that replays scripted responses and records every request it receives.
 * It is deliberately not selectable from configuration, so it can never appear as a live AI in any environment.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted-test"; readonly model = "scripted";
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly script: Array<LlmResponse | ProviderUnavailable | ((req: LlmRequest) => LlmResponse)>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.script[this.i++];
    if (!next) throw new Error("scripted provider ran out of responses");
    if (next instanceof ProviderUnavailable) throw next;
    return typeof next === "function" ? next(req) : next;
  }
}

export const reply = (content: LlmResponse["content"], stopReason: LlmResponse["stopReason"] = "tool_use", usage = { inputTokens: 100, outputTokens: 50 }): LlmResponse =>
  ({ content, stopReason, usage, model: "scripted" });
export const toolCall = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
