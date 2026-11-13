# AI data flow

What the optional AI assistant sees, stores and can do. We do not claim zero knowledge: text sent to the AI provider is processed by that provider. The product works fully without AI.

## Provider and credentials
One provider so far: Anthropic, through the official SDK (`@anthropic-ai/sdk`), model configurable (`AI_MODEL`, default `claude-opus-5-5`). The API key (`ANTHROPIC_API_KEY`) exists only in the server environment: never in the browser, logs, database or analytics. With no provider configured every AI feature reports **"AI assistant unavailable"**; there is no canned answer presented as AI. A scripted test provider exists only inside the test suite and cannot be selected by configuration.

## 1. Request intake (buyer, optional)
**Sent to the provider:** a fixed system prompt; today's date, weekday and the buyer's timezone; the description the buyer typed (max 2,000 characters), inside `<description>` tags and declared to be data, not instructions; and the outcomes of the three allowed tools. The validation tool returns only which fields are missing or invalid, not values.
**Not sent:** organisation name, user name or email, supplier data, prices, other requests. (If the buyer types an address into the description, it is sent; the screen says so before they use it.)
**What the model may do:** call `validate_request_requirements`, `request_clarification` (up to three questions), or `submit_structured_request`. Submitting only returns a **proposal** for a person to review; it saves and publishes nothing. Tools that change anything (publishing, approving, ordering) exist only behind explicit human API calls and are neither described to nor callable by the model; any attempt is recorded as `TOOL_NOT_ALLOWED` and does nothing. Every value is re-validated by deterministic rules (item, quantity, unit, NGN amount, deadline with timezone in the future, timezone, area, address) regardless of what the model says.

## 2. Comparison explanation (buyer, optional)
**Sent:** suppliers as labels ("Supplier A"), rank, landed total, goods, delivery and other charges as formatted text, exclusion reasons, and each supplier's payment-terms text **truncated to 80 characters inside a named data field** (supplier text is untrusted). No tools are offered at all.
**Not sent:** supplier names, addresses, the buyer's budget, dates, contact details.
**Output check:** a summary is shown only if every figure and supplier label in it matches the calculation, it has no link or markup, no percentage, no "approve/ignore/instruction"-style phrase and is short. Otherwise it is **discarded** and only the rule-based explanation (always computed, labelled "not by AI") is shown. The AI summary is labelled as AI and as possibly wrong; the comparison figures are the record.

## 3. Supplier quote agent: no AI
Prices come from the supplier's catalogue and settings by exact integer arithmetic (`quoteAgentRules.ts`). No language model sets, adjusts or explains a price, and buyer text is never read by it, so nothing a buyer writes can change what it quotes. It refuses (area, stock, deadline, units, no allowed product) instead of guessing. Drafts need a person to submit them unless the **organisation owner** switches review off; authority of the agent is rechecked at submission, and its quotes qualify for the verified lane only while identity and authority hold.

## What is stored
`AgentRun`: kind, state, a SHA-256 of the input and its length (**not the text**), provider and model names, token counts, cost in micro-USD, failure reason, and the result with the **delivery address redacted**. `ToolExecution`: tool name, status and redacted input and outcome, with a per-call idempotency key. **Never stored:** the buyer's raw description, the model's reasoning, API keys. Each run has token, tool-call, turn, cost and time limits; each person has an hourly run limit; a run can be cancelled; runs left mid-flight by a dead process are closed as failed on startup. No database transaction is held open during a model call.
**Retention:** no retention or deletion policy is implemented for runs yet. This is open and must be decided before real use.

## Known limits
The live provider path has **never been exercised**: no API key was available. Tests use a scripted model. The optional server-side refusal fallback (`AI_REFUSAL_FALLBACK`) is off because it could not be tested. Default prices (`AI_*_MICROUSD_PER_MTOK`) are Anthropic's published rates as cached on 2026-11-03: verify them before relying on cost figures. A real-provider check, with a bounded cost, still needs a key and the owner's approval of the spend.
