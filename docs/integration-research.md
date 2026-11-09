# Concordium integration research

Labels: **[Doc]** official documentation as fetched; **[Observed]** behaviour seen by our own call; **[Design]** our choice; **[Open]** unresolved.

## Access log

| Date (UTC) | Source | Method |
|---|---|---|
| 2026-11-09 | concordium.com grants announcement | WebFetch summary |
| 2026-11-09 | docs.concordium.com Registry MCP service page | WebFetch summary |
| 2026-11-09 | docs.concordium.com Concordium badge page | WebFetch summary |
| 2026-11-09 | proposals.concordium.com CIS-8004 | WebFetch summary |
| 2026-11-09 | agent-registry-mcp.concordium.com/mcp | `scripts/spike-registry.mjs` (read-only), raw output in `docs/spike-registry-output.json` |

Not yet read: hackathon brief, developer hub, agent-technology page, registry web app, wallet/Agent Card/x402/sponsored-transaction docs, SDK release notes. Fetched pages were summarised by a tool, not read in full; re-read primary pages before any claim is made in an application.

## Grants programme [Doc]

- Applicants must be registered companies; grants are paid only to registered companies.
- Pre-launch teams may apply if they disclose it; reviewers look for real usage (users, transactions, registered agents), a working Concordium integration, and two or three dated milestones.
- Process: form → call → agreed scope and milestones → written grant agreement → tranches (signing, build, milestone). Submission is not an offer.
- Applicants must confirm they hold the rights the project needs and are authorised to apply. Form: https://www.concordium.com/grant-application
- No closing date stated on the page. The hackathon (2 Nov – 9 Dec per the page) is a separate route.
- We make no claim of selection, amount, or eligibility. Applicant company details are **not specified** (see ownership checklist).

## Agent Registry MCP [Doc + Observed]

- Hosted endpoint **[Observed]**: `https://agent-registry-mcp.concordium.com/mcp` (Streamable HTTP; server `concordium-agent-registry-mcp` 0.1.0, protocol 2024-11-05). The `network` argument selects testnet/mainnet per call **[Observed]** (the docs page did not say how).
- 40 tools listed by `tools/list` [Observed], including `agent_by_token_address`, `agent_of`, `is_active`, `verify_agent_card`, `check_badge`, `get_badge_json`, `build_register`, `build_set_agent_uri`, `build_agent_card`, `build_agent_badge`, `build_cis8_*`, `set_agent_wallet_canonical_bytes`. **Docs/live discrepancy [Observed]:** the docs page lists `build_set_agent_uri` but the live `tools/list` does not contain it; the live list has `build_set_external_reference`, which the docs page omits. **[Open]** how to update `agent_uri` + `metadata_hash` (needed for the two-pass registration/badge flow) via the hosted service — confirm with Concordium or build the transaction with the SDK directly.
- Builders return `{hex, schema_json}`; the service holds no keys. The caller's wallet must sign and submit **[Doc]**.

| | Testnet [Observed 2026-11-09] | Mainnet [Observed 2026-11-09] |
|---|---|---|
| CIS-8004 registry | `<12802,0>` | `<10082,0>` (matches badge doc) |
| CIS-8 | `<12801,0>` | `<10081,0>` |
| gRPC | `https://grpc.testnet.concordium.com:20000` | mainnet gRPC (see raw output) |
| Explorer | `https://testnet.ccdscan.io` | `https://ccdscan.io` |
| Indexer | configured | configured |

Testnet and mainnet identifiers are separate config values in `packages/concordium/src/types.ts` and must never be mixed.

## Badge and card integrity [Doc]

- Badge lives in `capabilities.extensions[]` of the Agent Card under URI `https://docs.concordium.com/a2a-extensions/concordium-badge/v1`; params use CAIP-19 token address and CAIP-10 owner/contracts. Legacy top-level `concordium` object should also be accepted.
- Verification: parse token address → confirm trusted CIS-8004 contract → `agent_of` must be Active → fetch card at `agent_uri`, SHA-256 must equal on-chain `metadata_hash` → optional CIS-8 key check.
- **[Open] byte method**: the page mentions "canonical bytes" but defines no canonicalisation, while the integration guide hashes served bytes. We implement hash-of-served-bytes (`cardHashMatches`) and must confirm with Concordium before relying on it.
- **[Open] CIS-8004 spec** does not itself say `metadata_hash` commits to the card file; the badge docs do. Treat the badge docs as the operative rule and ask the authors.
- Brand: the "Verified by Concordium" mark must come from the official brand kit, link to the resolved badge, and be shown with the badge string. We have not obtained the brand kit; **no mark is used** until we do.

## CIS-8004 semantics [Doc]

Only accounts register; owner is the CIS-2 owner; transfer clears external reference and agent wallet (new owner must call `setAgentWallet`); revoke is final for most operations. Consequence for us **[Design]**: a changed owner must invalidate organisation authority until reauthorised (the verifier compares current owner with the *expected bound* owner every check).

## Design decisions [Design]

- Verification statuses are ours (`verified | unverified | pending | revoked | stale | unavailable | invalid`); upstream responses will be mapped explicitly, never passed through.
- Freshness policy default 300 s, configurable (`VERIFICATION_FRESHNESS_SECONDS`). It is our policy, not a Concordium guarantee.
- Card fetches: https only, no credentials, port 443, no private/reserved addresses (including IPv4-mapped IPv6), size cap 256 KiB. Fetcher must additionally check each resolved address and not follow redirects automatically (**not yet implemented**).

## Not yet tested / blockers

| Item | State |
|---|---|
| Real `check_badge`/`verify_agent_card` response shapes | **Not yet observed.** Needs a registered testnet agent; adapter deliberately returns `unavailable (NOT_IMPLEMENTED)` until then. |
| Wallet and ownership proof (signed challenge) | Not started. Needs the wallet signing format from official wallet docs. |
| Nigerian identity documents / mobile wallet compatibility | **Unverified**; must be checked against official docs and a real device. No promise of universal onboarding. |
| x402 on Concordium (network, asset, facilitator) | Not researched. Payment adapter stays `disabled`. |
| Sponsored transactions | Not researched. |
| Latest SDK releases | Not recorded; `@concordium/web-sdk` not yet installed. |
