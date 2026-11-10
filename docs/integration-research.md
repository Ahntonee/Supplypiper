# Concordium integration research

Labels: **[Doc]** official documentation as fetched; **[Observed]** behaviour seen by our own calls; **[Design]** our choice; **[Open]** unresolved or untested.

## Access log

| Date (UTC) | Source | Method |
|---|---|---|
| 2026-11-09 | concordium.com grants announcement; docs.concordium.com registry MCP page, badge page; proposals.concordium.com CIS-8004 | WebFetch summaries (not read in full) |
| 2026-11-09 | agent-registry-mcp.concordium.com/mcp | `scripts/spike-registry.mjs` → `docs/spike-registry-output.json` |
| 2026-11-10 | same, per network | `scripts/probe-registry.mjs` → `docs/registry-probe-{testnet,mainnet}.json` (full tool schemas and real responses) |
| 2026-11-10 | same, scan of 200 active testnet agents | `scripts/find-valid-agents.mjs` → `docs/registry-valid-agents-testnet.json` |
| 2026-11-10 | real card host `agentcards.site`, real testnet gRPC node | fetched and hashed by us; `packages/concordium/fixtures/` |
| 2026-11-10 | `@concordium/web-sdk` 12.0.2 | installed; `signMessage`, `verifyMessageSignature`, gRPC node client exercised |

Still not read first-hand: hackathon brief, developer hub, wallet signing docs, x402, sponsored transactions, SDK release notes. The recorded JSON files contain public on-chain data of third-party test agents (account addresses, card URLs); one real on-chain `agent_uri` is a `<script>` tag.

## Grants programme [Doc]
Registered companies only; pre-launch teams may apply and disclose it; reviewers want real usage, a working integration and two or three dated milestones; written agreement before funding; the hackathon is a separate route. No claim of selection, amount or eligibility is made. Applicant company details are **Not specified in this brief** (see `docs/ownership-and-rights-checklist.md`).

## Agent Registry MCP

**Hosted endpoint [Observed]:** `https://agent-registry-mcp.concordium.com/mcp`, Streamable HTTP, server `concordium-agent-registry-mcp` 0.1.0, protocol 2024-11-05, 40 tools. Needs `initialize` → `notifications/initialized`, then `tools/call`; replies come as SSE `data:` lines. **The `network` argument defaults to `mainnet` when omitted [Observed schema]; we always pass it explicitly.**

| | Testnet | Mainnet |
|---|---|---|
| CIS-8004 registry | `<12802,0>` | `<10082,0>` |
| CIS-8 | `<12801,0>` | `<10081,0>` |
| CAIP-2 chain id (genesis hash prefix) | `4221332d34e1694168c2a0c0b3fd0f27` | `9dd9ca4d19e9393877d2c44b70f89acb` |
| gRPC | `grpc.testnet.concordium.com:20000` | `grpc.mainnet.concordium.software:20000` |
| Explorer base | `https://testnet.ccdscan.io` | `https://ccdscan.io` |
| Registered agents when probed | 1,082 (125 revoked) | 5,134 |

Config lives in `packages/concordium/src/types.ts`. Testnet and mainnet values are never mixed (`UNTRUSTED_REGISTRY` if a token's contract is not the configured registry for the network).

### Real response shapes [Observed, 2026-11-10]
- `agent_of {token_id, network}` → record `{network, token_address, token_id, token_id_u64, owner_account, agent_uri, metadata_hash_hex, agent_wallet, status: "Active"|"Revoked", registered_at}`, plus `revoked_at` and `revocation_reason` when revoked. **Unknown id → `null` (not an error).**
- `is_active {token_id}` → `{exists, status, active}`. `verify_agent_card {token_id}` → includes the service's own fetch (`fetched.http_status`, `sha256_hex`, `match: true|false|null`). `check_badge {id: <token address>}` → `{checks{…}, badge_valid, issues[]}`. `get_badge_json {token_address}` → extension object incl. `verification.verifyUrl`.
- `token_address {contract_index, contract_subindex, token_id}` → `{token_address, …}`. `list_agents {limit≤500, offset, status, owner}` → `{count, total, agents[]}`.
- Malformed input → `isError: true` with a plain-text message (e.g. `Base58Check … invalid character`). We treat an error answer as **unavailable**, never as "not found".
- Tools take **`token_id`** (not the token address) for `agent_of`/`is_active`/`verify_agent_card`; `check_badge` takes `id`.
- The evidence link `https://agent-registry-mcp.concordium.com/v1/badge-check/<token address>` returned HTTP 200. It is hosted by Concordium; we show it as such.

### Findings that shaped the design
1. **Card hash method — resolved for the observed case.** The badge page said "canonical bytes" but defined none. For real testnet agent token 43, SHA-256 of the *exact bytes the card host served* equals the on-chain `metadata_hash_hex` (`68101d30…7d5e`). We hash served bytes. One agent is one observation, not a proof for every card.
2. **A matching hash is not a pass.** Of 200 active testnet agents scanned: 125 cards fetched, 83 matched their anchor, **1** passed every badge check. Most real cards have no valid Concordium badge. Hence `verified` requires hash match **and** a badge that agrees with the chain; matching hash alone is `unverified (BADGE_MISSING)`.
3. **Both badge embeddings exist in the wild.** The sanctioned A2A extension (CAIP-10 contract strings) and the legacy top-level `concordium` block (`<12802,0>` strings). The one passing agent uses the legacy form (the registry flags it as a warning). We accept both.
4. **Hostile data is real.** A real on-chain `agent_uri` was `<script src="https://gist…">`; a real card URL answers 404 with a JSON error. The hardened fetcher refuses the first without any network call; the second is `invalid (CARD_UNREACHABLE)`.
5. **Docs vs live tools.** The docs page lists `build_set_agent_uri`; the live `tools/list` does not (it has `build_set_external_reference`). **[Open]** how to update `agent_uri` + `metadata_hash` through the hosted service for the two-pass register/badge flow; building the transaction with the SDK directly is the likely route. Card publishing is **not implemented**.

### Token address format [Observed + Design]
`Base58Check(0x02 ‖ ULEB128(contract index) ‖ ULEB128(subindex) ‖ token id as 8 little-endian bytes)`. Our decoder and encoder reproduce the real badge strings `JyP9UhTu6PeHXpm6LAhSy` (<12802,0> #43), `JyP9U6SVHZgayqA5XfHfA` (#11), `JyP9TtQC3HCNrTYR3sc2T` (#0) and mainnet `Mf22oVneFJJsAWi8saupU` exactly. We decode the address ourselves rather than trusting the hosted parser.

## Ownership proof (wallet signature)
- **Method [Design, from SDK]:** server issues a one-time challenge (opaque ids only: audience, network, agent token, organisation id, user id, nonce, expiry; 10 minutes). The wallet signs it with the SDK's `signMessage` account signing; the server verifies with `verifyMessageSignature` against the account's **current on-chain keys**, so a rotated key stops working with no action by us. The stored message wins over the client's copy; the nonce is single-use; the challenge is bound to user, organisation and agent.
- **Keys read from chain [Observed]:** `ConcordiumGRPCNodeClient.getAccountInfo` on the testnet node returned the real credential keys (Ed25519) for a real agent-owner account.
- **Tested:** with SDK-generated signatures and locally generated keys (valid, wrong key, rotated key, other message, tampered message, expired, unknown account, chain outage, malformed signature); live: real account keys load and a wrong-key signature is refused.
- **[Open / blocked]:** a **positive** proof from a real wallet app has not been produced, and the wallet's exact signature output format has not been confirmed against our paste-JSON field. There is no browser-wallet connection; the UI step is manual and says so. Needed: a testnet wallet holding an account that owns a testnet agent.

## Verification flow [Design]
See `docs/agent-accountability.md`. Summary: our verifier decides from chain data (`agent_of`), our own card fetch and hash, and our own badge comparison. It does **not** use the hosted service's verdict tools to decide. Freshness default 300 s (`VERIFICATION_FRESHNESS_SECONDS`) is our policy, not a Concordium guarantee.

## Verified live (opt-in `LIVE_CONCORDIUM=1`, testnet, read-only)
Real agent #43 → `verified`; real revoked #11 → `revoked`; real agent #0 (card 404) → `invalid`; wrong expected owner on #43 → `invalid (OWNER_MISMATCH)`; real account keys load via gRPC. Without the flag these tests are reported **skipped**.

## Not done / blockers

| Item | State |
|---|---|
| Chain reads are trusted from one hosted service | `agent_of` comes from Concordium's hosted MCP. **[Open]** an independent read via direct contract invocation over gRPC would remove that single dependency; not built. |
| Positive wallet-signature proof; browser wallet connection | Blocked on a real wallet and testnet account (above). |
| Registration, Agent Card publishing, two-pass badge anchoring | Not built (`build_*` tools exist; `build_set_agent_uri` missing live). |
| Mainnet | Config and probe only. Verifier path never run against mainnet agents; not enabled outside production mode. |
| Nigerian identity documents, mobile-wallet compatibility | **Unverified.** No official-doc review or device test yet. No claim of universal onboarding; testnet identity is not production KYC. |
| x402 on Concordium (network, asset, facilitator), sponsored transactions | Not researched. Payment adapter stays `disabled`. |
| Official "Verified by Concordium" mark | Brand kit not obtained; **no mark is used**. |
| SDK release notes | Not recorded beyond the installed version (12.0.2). |
