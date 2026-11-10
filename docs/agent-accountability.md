# Agent accountability

What the product records, decides and shows about supplier agents. Verification establishes an **accountable owner**. It does not establish product quality, business registration, ability to fulfil, solvency, or endorsement by Concordium. Those five limits are returned with every result and shown in the UI.

## Four separate records
1. **Registration**: network, token address (decoded and checked against the trusted registry for the environment), who operates it (`supplier_owned` or `platform_operated`, disclosed to buyers; a platform-operated agent is never presented as independent supplier ownership).
2. **Proven owner**: set only by a verified wallet signature over a one-time challenge. A pasted address is never trusted. Re-proving a *different* account clears organisation authority.
3. **Organisation authority**: a separate action by the organisation **owner** only (`agent.authorise`). Bound to one owner account; if the owner changes it stops counting (`authorityValid`). The database refuses authority without a proven owner.
4. **Verification attempts**: every check is stored (status, network, reasons, evidence, time, simulated flag). The latest check and the **last successful** check are shown separately.

## Statuses (ours, not upstream's)
`verified` (all checks passed) · `unverified` (cannot yet be established: no owner proof, no badge) · `invalid` (wrong owner, unknown agent, card hash mismatch, bad badge, bad card address, untrusted registry) · `revoked` · `unavailable` (registry, card host or chain unreachable; retry later) · `pending`, `stale` (display states).

A pass requires: token decodes and belongs to the configured registry for this network; agent exists; status Active; on-chain owner equals the proven owner; the card, fetched by us, hashes (SHA-256 of served bytes) to the on-chain anchor; the card's badge agrees with the chain (token, owner, chain, registry).

## Where it gates decisions
- **Comparison**: an agent-sourced quote enters the verified lane only with a fresh `verified` observation (≤ freshness policy) **and** valid organisation authority **and** an agent registered to the quoting organisation. Otherwise it is excluded with a specific reason. Manual quotes never inherit anything and keep working during an outage.
- **Approval commit**: identity is re-checked **at commit**, outside the database transaction, and the observation is bound to the quote version it was made for. A cached green result is never enough; a registry outage returns `VERIFICATION_NOT_FRESH` and no order is created. The result is recorded on the order. External state can still change after the check: we record the observation and do not claim atomicity across chain and database.
- **Outage**: read-only browsing and drafting continue; only verified-lane actions are blocked.

## Safety of untrusted input
Card URLs: https only, no credentials, port 443, no IP literals, no redirects, 256 KiB cap, 8 s timeout, and private/reserved addresses refused **at connect time** (DNS-rebinding safe). Card JSON and registry text are data, never instructions. Ownership challenges contain opaque ids only.

## Environments
`demo`: simulated checker, every result labelled simulated and network `demo`. `testnet`: real registry, testnet only, labelled testnet, never described as KYC. `production`: mainnet only, no mock fallback (startup refuses the mock adapter).

## Known limits
Quote-creating agents do not exist yet, so agent-sourced quotes cannot be created through the product; the gating is tested by inserting them directly. Chain reads depend on one hosted service (see research). No positive real-wallet proof yet. No card publishing or registration flow.
