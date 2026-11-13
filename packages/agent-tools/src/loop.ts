import type { ZodType } from "zod";
import { costMicroUsd, ProviderUnavailable, type LlmMessage, type LlmProvider, type LlmToolSpec, type Pricing, type ToolResultBlock, type ToolUseBlock } from "./provider";

/**
 * A tool the model may ask for. Authority comes from THIS policy, enforced by the executor, never from the system prompt.
 * `modelCallable: false` tools exist for server code that acts after a human confirmation; a model can never invoke them.
 */
export interface ToolDefinition<I = unknown> {
  name: string; description: string; inputSchema: Record<string, unknown>; validate: ZodType<I>;
  modelCallable: boolean; mutating: boolean; requiresHumanConfirmation: boolean;
  /** Ends the run with this tool's output as the result. A function decides per output (e.g. only when the output is valid). */
  terminal?: boolean | ((output: unknown) => boolean);
  timeoutMs?: number;
  run(input: I): Promise<unknown>;
  /** Removes sensitive values before the input or outcome is stored in the trace. */
  redact?(value: unknown): unknown;
}

export interface Budget { maxToolCalls: number; maxTurns: number; costLimitMicroUsd: number; deadlineMs: number; maxOutputTokensPerCall: number }

export interface ExecutionRecord { tool: string; key: string; input: unknown; outcome: unknown; status: "ok" | "error" | "rejected"; }
/** Persistence for a run. Implementations must NOT hold a database transaction across a model or network call. */
export interface RunStore {
  isCancelled(): Promise<boolean>;
  findExecution(key: string): Promise<ExecutionRecord | null>;
  saveExecution(rec: ExecutionRecord): Promise<void>;
  addUsage(usage: { inputTokens: number; outputTokens: number }, costMicroUsd: number): Promise<void>;
}

export type FailReason = "PROVIDER_UNAVAILABLE" | "REFUSED" | "BUDGET_TOOL_CALLS" | "BUDGET_COST" | "BUDGET_TURNS" | "TIMEOUT" | "TRUNCATED";
export type LoopOutcome =
  | { kind: "terminal"; tool: string; output: unknown }
  | { kind: "text"; text: string }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: FailReason; detail?: string };

export interface LoopInput {
  provider: LlmProvider; pricing: Pricing; tools: ToolDefinition<never>[]; system: string; userMessage: string;
  store: RunStore; budget: Budget; runId: string; effort?: "low" | "medium" | "high"; now?: () => number;
}

const asSpec = (t: ToolDefinition<never>): LlmToolSpec => ({ name: t.name, description: t.description, input_schema: t.inputSchema });
const json = (v: unknown) => JSON.stringify(v);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("TOOL_TIMEOUT")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Executes one model-requested tool call under policy. Returns the text the model sees as the tool result. */
export async function executeToolCall(call: ToolUseBlock, input: LoopInput): Promise<{ result: ToolResultBlock; terminal?: { tool: string; output: unknown } }> {
  const { store, runId } = input;
  const key = `${runId}:${call.id}`;
  const done = (content: string, isError: boolean): ToolResultBlock => ({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });

  const prior = await store.findExecution(key); // at-least-once delivery: a replay returns the recorded outcome and runs nothing
  if (prior) return { result: done(json(prior.outcome), prior.status !== "ok") };

  const def = input.tools.find((t) => t.name === call.name);
  if (!def || !def.modelCallable || def.mutating || def.requiresHumanConfirmation) {
    const outcome = { error: "TOOL_NOT_ALLOWED", message: "This tool is not available to the assistant." };
    await store.saveExecution({ tool: call.name, key, input: "[not recorded: disallowed tool]", outcome, status: "rejected" });
    return { result: done(json(outcome), true) };
  }
  const parsed = def.validate.safeParse(call.input);
  if (!parsed.success) {
    const outcome = { error: "INVALID_INPUT", problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
    await store.saveExecution({ tool: def.name, key, input: def.redact ? def.redact(call.input) : call.input, outcome, status: "error" });
    return { result: done(json(outcome), true) };
  }
  try {
    const out = await withTimeout(def.run(parsed.data as never), def.timeoutMs ?? 10_000);
    await store.saveExecution({ tool: def.name, key, input: def.redact ? def.redact(parsed.data) : parsed.data, outcome: def.redact ? def.redact(out) : out, status: "ok" });
    const ends = typeof def.terminal === "function" ? def.terminal(out) : !!def.terminal;
    return { result: done(json(out), false), ...(ends ? { terminal: { tool: def.name, output: out } } : {}) };
  } catch (e) {
    const outcome = { error: (e as Error).message === "TOOL_TIMEOUT" ? "TOOL_TIMEOUT" : "TOOL_FAILED" };
    await store.saveExecution({ tool: def.name, key, input: def.redact ? def.redact(parsed.data) : parsed.data, outcome, status: "error" });
    return { result: done(json(outcome), true) };
  }
}

/** Bounded tool loop. Every limit is checked before the next model call; a database transaction is never open during one. */
export async function runLoop(input: LoopInput): Promise<LoopOutcome> {
  const clock = input.now ?? Date.now;
  const startedAt = clock();
  const messages: LlmMessage[] = [{ role: "user", content: input.userMessage }];
  let toolCalls = 0; let costMicro = 0;
  const specs = input.tools.filter((t) => t.modelCallable && !t.mutating && !t.requiresHumanConfirmation).map(asSpec);

  for (let turn = 1; turn <= input.budget.maxTurns; turn++) {
    if (await input.store.isCancelled()) return { kind: "cancelled" };
    if (clock() - startedAt > input.budget.deadlineMs) return { kind: "failed", reason: "TIMEOUT" };
    const remainingMicro = input.budget.costLimitMicroUsd - costMicro;
    if (remainingMicro <= 0) return { kind: "failed", reason: "BUDGET_COST" };
    // Worst case for this call cannot exceed what is left of the budget.
    const affordable = Math.floor((remainingMicro * 1_000_000) / Math.max(1, input.pricing.outputMicroUsdPerMTok));
    const maxTokens = Math.min(input.budget.maxOutputTokensPerCall, affordable);
    if (maxTokens < 64) return { kind: "failed", reason: "BUDGET_COST" };

    let res;
    try { res = await input.provider.complete({ system: input.system, messages, tools: specs, maxTokens, effort: input.effort }); }
    catch (e) {
      if (e instanceof ProviderUnavailable) return { kind: "failed", reason: "PROVIDER_UNAVAILABLE", detail: e.reason };
      throw e;
    }
    const c = costMicroUsd(res.usage, input.pricing);
    costMicro += c;
    await input.store.addUsage(res.usage, c);
    if (res.stopReason === "refusal") return { kind: "failed", reason: "REFUSED" };
    if (res.stopReason === "max_tokens") return { kind: "failed", reason: "TRUNCATED" };

    const uses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
      return { kind: "text", text };
    }
    messages.push({ role: "assistant", content: res.content });
    const results: ToolResultBlock[] = [];
    for (const call of uses) {
      if (++toolCalls > input.budget.maxToolCalls) return { kind: "failed", reason: "BUDGET_TOOL_CALLS" };
      const r = await executeToolCall(call, input);
      results.push(r.result);
      if (r.terminal) return { kind: "terminal", tool: r.terminal.tool, output: r.terminal.output };
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "failed", reason: "BUDGET_TURNS" };
}
