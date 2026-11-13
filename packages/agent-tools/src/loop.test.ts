import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  costMicroUsd, executeToolCall, ProviderUnavailable, reply, runLoop, ScriptedProvider, toolCall,
  type Budget, type ExecutionRecord, type LoopInput, type RunStore, type ToolDefinition,
} from "./index";

const PRICING = { inputMicroUsdPerMTok: 4_000_000, outputMicroUsdPerMTok: 20_000_000 };
const BUDGET: Budget = { maxToolCalls: 5, maxTurns: 6, costLimitMicroUsd: 1_000_000, deadlineMs: 60_000, maxOutputTokensPerCall: 1000 };

class MemStore implements RunStore {
  executions = new Map<string, ExecutionRecord>(); usage = { in: 0, out: 0, cost: 0 }; cancelAfterCalls = Infinity; private polls = 0;
  async isCancelled() { return ++this.polls > this.cancelAfterCalls; }
  async findExecution(k: string) { return this.executions.get(k) ?? null; }
  async saveExecution(r: ExecutionRecord) { this.executions.set(r.key, r); }
  async addUsage(u: { inputTokens: number; outputTokens: number }, c: number) { this.usage.in += u.inputTokens; this.usage.out += u.outputTokens; this.usage.cost += c; }
}

function tools() {
  const run = { check: vi.fn(async (i: { n: number }) => ({ doubled: i.n * 2 })), submit: vi.fn(async (i: { answer: string }) => ({ accepted: i.answer })), publish: vi.fn(async () => ({ published: true })), humanOnly: vi.fn(async () => ({ ok: 1 })), hidden: vi.fn(async () => ({ ok: 1 })), slow: vi.fn(() => new Promise(() => {})), boom: vi.fn(async () => { throw new Error("secret internal detail"); }) };
  const mk = (name: string, p: Partial<ToolDefinition<never>> & { run: (i: never) => Promise<unknown> }): ToolDefinition<never> => ({
    name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: z.object({}).passthrough() as never, modelCallable: true, mutating: false, requiresHumanConfirmation: false, ...p,
  });
  const defs: ToolDefinition<never>[] = [
    mk("check", { validate: z.object({ n: z.number() }).strict() as never, run: run.check as never }),
    mk("submit", { validate: z.object({ answer: z.string() }).strict() as never, terminal: true, run: run.submit as never, redact: (v) => (typeof v === "object" && v ? { ...(v as object), answer: "[redacted]", accepted: "[redacted]" } : v) }),
    mk("publish_approved_rfq", { mutating: true, run: run.publish as never }),
    mk("human_only", { requiresHumanConfirmation: true, run: run.humanOnly as never }),
    mk("hidden", { modelCallable: false, run: run.hidden as never }),
    mk("slow", { timeoutMs: 30, run: run.slow as never }),
    mk("boom", { run: run.boom as never }),
  ];
  return { defs, run };
}
const input = (provider: ScriptedProvider, store: MemStore, defs: ToolDefinition<never>[], over: Partial<LoopInput> = {}): LoopInput =>
  ({ provider, pricing: PRICING, tools: defs, system: "sys", userMessage: "go", store, budget: BUDGET, runId: "run1", ...over });

describe("tool loop", () => {
  it("runs a validated tool, then a terminal tool, and accounts usage and cost", async () => {
    const { defs, run } = tools(); const store = new MemStore();
    const p = new ScriptedProvider([reply([toolCall("a", "check", { n: 4 })]), reply([toolCall("b", "submit", { answer: "x" })])]);
    const out = await runLoop(input(p, store, defs));
    expect(out).toEqual({ kind: "terminal", tool: "submit", output: { accepted: "x" } });
    expect(run.check).toHaveBeenCalledWith({ n: 4 });
    expect(store.usage).toMatchObject({ in: 200, out: 100 });
    expect(store.usage.cost).toBe(costMicroUsd({ inputTokens: 200, outputTokens: 100 }, PRICING) );
    expect(costMicroUsd({ inputTokens: 1000, outputTokens: 500 }, PRICING)).toBe(14_000);
  });

  it("never offers, and never runs, tools a model may not use (mutating, human-confirmed, hidden, unknown)", async () => {
    const { defs, run } = tools(); const store = new MemStore();
    const p = new ScriptedProvider([
      reply([toolCall("1", "publish_approved_rfq", {}), toolCall("2", "human_only", {}), toolCall("3", "hidden", {}), toolCall("4", "drop_database", {})]),
      reply([{ type: "text", text: "done" }], "end_turn"),
    ]);
    const out = await runLoop(input(p, store, defs));
    expect(out).toEqual({ kind: "text", text: "done" });
    expect(run.publish).not.toHaveBeenCalled(); expect(run.humanOnly).not.toHaveBeenCalled(); expect(run.hidden).not.toHaveBeenCalled();
    const offered = p.requests[0]!.tools.map((t) => t.name);
    expect(offered).toEqual(["check", "submit", "slow", "boom"]); // mutating/human/hidden tools are not even described to the model
    for (const k of ["run1:1", "run1:2", "run1:3", "run1:4"]) expect(store.executions.get(k)).toMatchObject({ status: "rejected", outcome: { error: "TOOL_NOT_ALLOWED" } });
  });

  it("returns schema problems to the model instead of running the tool", async () => {
    const { defs, run } = tools(); const store = new MemStore();
    const p = new ScriptedProvider([reply([toolCall("a", "check", { n: "four", extra: 1 })]), reply([{ type: "text", text: "ok" }], "end_turn")]);
    await runLoop(input(p, store, defs));
    expect(run.check).not.toHaveBeenCalled();
    const second = p.requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>;
    expect(second[0]!.is_error).toBe(true);
    expect(JSON.parse(second[0]!.content).error).toBe("INVALID_INPUT");
  });

  it("is safe under at-least-once delivery: replaying a tool call id returns the recorded outcome and runs nothing", async () => {
    const { defs, run } = tools(); const store = new MemStore();
    const call = toolCall("same", "check", { n: 1 });
    const a = await executeToolCall(call, input(new ScriptedProvider([]), store, defs));
    const b = await executeToolCall(call, input(new ScriptedProvider([]), store, defs));
    expect(run.check).toHaveBeenCalledTimes(1);
    expect(b.result.content).toBe(a.result.content);
  });

  it("stores a redacted trace and keeps tool failures from leaking internals", async () => {
    const { defs } = tools(); const store = new MemStore();
    await runLoop(input(new ScriptedProvider([reply([toolCall("s", "submit", { answer: "12 Allen Avenue" })])]), store, defs));
    expect(JSON.stringify([...store.executions.values()])).not.toContain("12 Allen Avenue");
    const r = await executeToolCall(toolCall("b", "boom", {}), input(new ScriptedProvider([]), store, defs));
    expect(r.result.content).not.toContain("secret internal detail");
    expect(JSON.parse(r.result.content).error).toBe("TOOL_FAILED");
    const t = await executeToolCall(toolCall("t", "slow", {}), input(new ScriptedProvider([]), store, defs));
    expect(JSON.parse(t.result.content).error).toBe("TOOL_TIMEOUT");
  });
});

describe("budgets, cancellation and failure", () => {
  it("stops at the tool-call limit", async () => {
    const { defs } = tools();
    const p = new ScriptedProvider(Array.from({ length: 6 }, (_, i) => reply([toolCall(`c${i}`, "check", { n: i }), toolCall(`d${i}`, "check", { n: i })])));
    expect(await runLoop(input(p, new MemStore(), defs, { budget: { ...BUDGET, maxToolCalls: 3 } }))).toEqual({ kind: "failed", reason: "BUDGET_TOOL_CALLS" });
  });
  it("stops at the turn limit", async () => {
    const { defs } = tools();
    const p = new ScriptedProvider(Array.from({ length: 4 }, (_, i) => reply([toolCall(`c${i}`, "check", { n: i })])));
    expect(await runLoop(input(p, new MemStore(), defs, { budget: { ...BUDGET, maxTurns: 3 } }))).toEqual({ kind: "failed", reason: "BUDGET_TURNS" });
  });
  it("stops when the cost limit is spent and caps each call to what is left", async () => {
    const { defs } = tools();
    const big = reply([toolCall("a", "check", { n: 1 })], "tool_use", { inputTokens: 100_000, outputTokens: 20_000 }); // 400,000 + 400,000 = 800,000 micro-USD
    const p = new ScriptedProvider([big, big, big]);
    const out = await runLoop(input(p, new MemStore(), defs, { budget: { ...BUDGET, costLimitMicroUsd: 1_000_000 } }));
    expect(out).toEqual({ kind: "failed", reason: "BUDGET_COST" });
    // second call: only 200,000 micro-USD left = 10,000 output tokens at 20 USD/MTok, below the per-call cap of 1000? no: cap wins
    expect(p.requests[1]!.maxTokens).toBeLessThanOrEqual(1000);
    const tight = new ScriptedProvider([reply([{ type: "text", text: "x" }], "end_turn")]);
    await runLoop(input(tight, new MemStore(), defs, { budget: { ...BUDGET, costLimitMicroUsd: 10_000, maxOutputTokensPerCall: 100_000 } }));
    expect(tight.requests[0]!.maxTokens).toBe(500); // 10,000 micro-USD buys exactly 500 output tokens at 20 USD/MTok
  });
  it("refuses to start a call it cannot afford", async () => {
    const { defs } = tools();
    expect(await runLoop(input(new ScriptedProvider([]), new MemStore(), defs, { budget: { ...BUDGET, costLimitMicroUsd: 1 } }))).toEqual({ kind: "failed", reason: "BUDGET_COST" });
  });
  it("stops at the deadline", async () => {
    const { defs } = tools(); let t = 0;
    const p = new ScriptedProvider([reply([toolCall("a", "check", { n: 1 })]), reply([toolCall("b", "check", { n: 1 })])]);
    const out = await runLoop(input(p, new MemStore(), defs, { now: () => (t += 40_000), budget: { ...BUDGET, deadlineMs: 60_000 } }));
    expect(out).toEqual({ kind: "failed", reason: "TIMEOUT" });
  });
  it("honours cancellation between turns and makes no further model call", async () => {
    const { defs } = tools(); const store = new MemStore(); store.cancelAfterCalls = 1;
    const p = new ScriptedProvider([reply([toolCall("a", "check", { n: 1 })]), reply([toolCall("b", "check", { n: 1 })])]);
    expect(await runLoop(input(p, store, defs))).toEqual({ kind: "cancelled" });
    expect(p.requests).toHaveLength(1);
  });
  it("reports provider outage, refusal and truncation as distinct failures", async () => {
    const { defs } = tools();
    expect(await runLoop(input(new ScriptedProvider([new ProviderUnavailable("down", "OUTAGE")]), new MemStore(), defs))).toEqual({ kind: "failed", reason: "PROVIDER_UNAVAILABLE", detail: "OUTAGE" });
    expect(await runLoop(input(new ScriptedProvider([reply([], "refusal")]), new MemStore(), defs))).toEqual({ kind: "failed", reason: "REFUSED" });
    expect(await runLoop(input(new ScriptedProvider([reply([{ type: "text", text: "cut" }], "max_tokens")]), new MemStore(), defs))).toEqual({ kind: "failed", reason: "TRUNCATED" });
  });
});
