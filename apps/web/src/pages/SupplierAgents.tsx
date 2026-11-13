import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError, type OrgSummary } from "../api";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, EvidencePanel, Field, Input, PageTitle, Skeleton, Textarea, type EvidenceState } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { mayDo } from "../format";
import { fmtDate, useEnv } from "../session";

export interface CheckView {
  status: EvidenceState; network: "testnet" | "mainnet" | "demo"; checkedAt: string; ageSeconds: number; freshForOrders: boolean; reasons: string[]; simulated: boolean;
  evidenceUrl: string | null; revocationReason: string | null; established: string[]; notEstablished: string[];
}
interface Agent {
  id: string; network: "testnet" | "mainnet"; tokenAddress: string; registry: string; operatorType: string; operatorNote: string; ownerAccount: string | null; ownerProvedAt: string | null;
  authority: { bound: boolean; boundAt: string | null; voidBecauseOwnerChanged: boolean }; latestCheck: CheckView | null; lastSuccessfulCheckAt: string | null; checksAvailable: boolean;
}
interface AgentList { agents: Agent[]; environment: { networks: string[]; freshnessSeconds: number } }

export const REASON_PLAIN: Record<string, string> = {
  CHECK_OK: "All checks passed.", OWNERSHIP_PROOF_MISSING: "No wallet-signature proof of the owner is on record.", AGENT_NOT_FOUND: "No such agent in the registry.",
  AGENT_REVOKED: "The agent was revoked on-chain.", OWNER_MISMATCH: "The on-chain owner is no longer the account you proved. Prove ownership again.", UNTRUSTED_REGISTRY: "The token is not in the trusted registry.",
  CARD_UNREACHABLE: "The agent's published card could not be retrieved.", CARD_HASH_MISMATCH: "The published card does not match its on-chain anchor.", CARD_URL_REJECTED: "The card address was refused as unsafe.",
  BADGE_MISSING: "The card carries no Concordium badge.", BADGE_MISMATCH: "The card's badge does not match the on-chain record.", BADGE_MALFORMED: "The card is not valid JSON.",
  UPSTREAM_UNREACHABLE: "The registry could not be reached. Verification is unavailable right now.", TOKEN_ADDRESS_INVALID: "That is not a valid agent token address.", DEMO_SIMULATED: "Simulated result (demo only).",
};

const registerSchema = z.object({ tokenAddress: z.string().trim().min(10, "Paste the agent's badge string").max(60), operatorType: z.enum(["supplier_owned", "platform_operated"]) });

export function SupplierAgents() {
  const { org } = useOutletContext<ShellContext>();
  const env = useEnv();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agents", org?.id], enabled: !!org?.capabilities.includes("supplier"), queryFn: () => api<AgentList>("GET", `/orgs/${org!.id}/agents`) });
  const [err, setErr] = useState<ApiError | null>(null);
  const canManage = mayDo(org, "agent.manage");
  const network = q.data?.environment.networks[0] ?? "testnet";
  const simulated = env.data?.verificationAdapter === "mock";
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema), mode: "onTouched", defaultValues: { operatorType: "supplier_owned" } });
  const add = useMutation({
    mutationFn: (v: z.infer<typeof registerSchema>) => api("POST", `/orgs/${org!.id}/agents`, { ...v, network }),
    onSuccess: async () => { setErr(null); reset(); await qc.invalidateQueries({ queryKey: ["agents", org?.id] }); },
    onError: (e) => setErr(e as ApiError),
  });
  if (org && !org.capabilities.includes("supplier")) return <Alert tone="attention" title="Supplying is not enabled for this organisation">Switch to a supplying organisation to use this page.</Alert>;
  if (!org || q.isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="grid max-w-4xl gap-6">
      <PageTitle title="Agent identity and authority" sub="Identity shows who is accountable for an agent. It is not a quality mark, a business check, or a promise to deliver." />
      <Alert tone={simulated ? "attention" : "info"} title={simulated ? "Demo: identity results here are simulated" : `${network === "testnet" ? "Testnet" : "Mainnet"} identity`}>
        {simulated ? "This environment uses a simulated checker. Every result is labelled simulated and proves nothing about a real agent." : network === "testnet" ? "Testnet identity uses test tokens and is not a production identity check or KYC." : "Results come from Concordium's public registry, re-checked just before an order is committed."}
      </Alert>

      <Card className="grid gap-2">
        <h2 className="text-lg font-semibold">Four separate steps</h2>
        <ol className="list-decimal pl-5 text-sm text-text-muted">
          <li><strong className="text-text">Register</strong> the agent's badge string. A pasted address alone is never trusted.</li>
          <li><strong className="text-text">Prove ownership</strong> by signing a one-time message with the Concordium account that owns the agent.</li>
          <li><strong className="text-text">Authorise</strong> (organisation owner only): your organisation allows this agent to quote for it. This is a different record from identity.</li>
          <li><strong className="text-text">Check</strong>: SupplyPiper asks the registry, and asks again just before a buyer's order is committed. A result older than {q.data ? Math.round(q.data.environment.freshnessSeconds / 60) : 5} minutes, or a registry outage, never counts as proof.</li>
        </ol>
        <p className="text-xs text-text-muted">Once an agent is authorised, your quote agent (see Quote agent) can prepare quote drafts under it. Its quotes enter the buyer's verified lane only while this check keeps passing.</p>
      </Card>

      {canManage && (
        <Card className="grid gap-3">
          <h2 className="text-lg font-semibold">Register an agent</h2>
          {err && <Alert tone="danger" title="Could not register">{err.message}</Alert>}
          <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setErr(null); add.mutate(v); })}>
            <Field label="Agent badge string (token address)" hint={`The token's address in the ${network} agent registry, for example JyP9UhTu6PeHXpm6LAhSy.`} error={errors.tokenAddress?.message}>{(a) => <Input {...a} autoComplete="off" spellCheck={false} {...register("tokenAddress")} />}</Field>
            <fieldset className="grid gap-1">
              <legend className="text-sm font-medium">Who operates this agent?</legend>
              <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" value="supplier_owned" className="size-5 accent-[var(--primary)]" {...register("operatorType")} />Our business operates it</label>
              <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" value="platform_operated" className="size-5 accent-[var(--primary)]" {...register("operatorType")} />The SupplyPiper platform operates it for us (shown to buyers as platform-operated)</label>
            </fieldset>
            <div><Button type="submit" pending={add.isPending}>Register agent</Button></div>
          </form>
        </Card>
      )}

      {q.isError && <Alert tone="danger" title="Could not load agents" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}
      {q.data?.agents.length === 0 && <EmptyState title="No agents registered">Register one above to start the identity and authority steps. Quotes entered by your team need none of this.</EmptyState>}
      {q.data?.agents.map((a) => <AgentCard key={a.id} a={a} org={org} />)}
    </div>
  );
}

function AgentCard({ a, org }: { a: Agent; org: OrgSummary }) {
  const qc = useQueryClient();
  const canManage = mayDo(org, "agent.manage"); const canAuthorise = mayDo(org, "agent.authorise");
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string; expiresAt: string; how: string } | null>(null);
  const [account, setAccount] = useState(""); const [sig, setSig] = useState(""); const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<null | "authorise" | "withdraw">(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["agents", org.id] });
  const fail = (e: unknown) => { const x = e as ApiError; setMsg({ tone: "danger", text: x.code === "OWNERSHIP_PROOF_FAILED" ? `The signature could not be verified (${x.details.reason}).` : x.message }); setConfirm(null); };

  const check = useMutation({ mutationFn: () => api("POST", `/orgs/${org.id}/agents/${a.id}/check`, {}), onSuccess: async () => { setMsg(null); await refresh(); }, onError: fail });
  const getChallenge = useMutation({ mutationFn: () => api<NonNullable<typeof challenge>>("POST", `/orgs/${org.id}/agents/${a.id}/challenge`, {}), onSuccess: (c) => { setMsg(null); setChallenge(c); }, onError: fail });
  let parsed: unknown = null; let sigBad = false;
  try { parsed = JSON.parse(sig); sigBad = !parsed || typeof parsed !== "object"; } catch { sigBad = sig.trim().length > 0 || touched; }
  const prove = useMutation({
    mutationFn: () => api("POST", `/orgs/${org.id}/agents/${a.id}/ownership`, { challengeId: challenge!.challengeId, account: account.trim(), message: challenge!.message, signature: parsed }),
    onSuccess: async () => { setMsg({ tone: "success", text: "Ownership proven. This is not yet authority to quote: that is a separate step." }); setChallenge(null); setSig(""); setAccount(""); setTouched(false); await refresh(); },
    onError: fail,
  });
  const authorise = useMutation({ mutationFn: () => api("POST", `/orgs/${org.id}/agents/${a.id}/authorise`, { confirm: true }), onSuccess: async () => { setMsg({ tone: "success", text: "Authority recorded for this owner account." }); setConfirm(null); await refresh(); }, onError: fail });
  const withdraw = useMutation({ mutationFn: () => api("POST", `/orgs/${org.id}/agents/${a.id}/withdraw-authority`, {}), onSuccess: async () => { setMsg({ tone: "success", text: "Authority withdrawn." }); setConfirm(null); await refresh(); }, onError: fail });

  const c = a.latestCheck;
  const identity: EvidenceState = c ? (c.status === "verified" && !c.freshForOrders ? "stale" : c.status) : "unverified";
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-all text-base font-semibold">{a.tokenAddress}</h2>
        <Badge tone="attention">{a.network === "testnet" ? "Testnet" : "Mainnet"}</Badge>
        <Badge tone={a.operatorType === "platform_operated" ? "info" : "neutral"}>{a.operatorType === "platform_operated" ? "Platform-operated" : "Supplier-operated"}</Badge>
      </div>
      <p className="-mt-2 text-xs text-text-muted">{a.operatorNote}</p>
      {msg && <Alert tone={msg.tone} title={msg.text} />}

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-text-muted">Owner proven by signature</dt><dd>{a.ownerAccount ? <><Badge tone="success">proven</Badge><span className="mt-1 block break-all text-xs text-text-muted">{a.ownerAccount}</span></> : <Badge tone="neutral">not proven</Badge>}</dd></div>
        <div><dt className="text-xs text-text-muted">Organisation authority</dt><dd>{a.authority.bound ? <Badge tone="success">authorised</Badge> : a.authority.voidBecauseOwnerChanged ? <Badge tone="danger">void: owner changed</Badge> : <Badge tone="neutral">not authorised</Badge>}</dd></div>
        <div><dt className="text-xs text-text-muted">Latest check</dt><dd>{c ? `${c.status} · ${fmtDate(c.checkedAt)}` : "Never"}</dd></div>
      </dl>
      {c && c.reasons.length > 0 && c.status !== "verified" && <p className="text-sm text-text-muted">{c.reasons.map((r) => REASON_PLAIN[r] ?? r).join(" ")}{c.revocationReason ? ` On-chain reason: "${c.revocationReason}".` : ""}</p>}
      <EvidencePanel identity={identity} authority={a.authority.bound ? "bound" : "not_bound"} network={c?.network ?? a.network} checkedAt={c ? `${fmtDate(c.checkedAt)} (${c.status})` : undefined} lastSuccessAt={a.lastSuccessfulCheckAt ? fmtDate(a.lastSuccessfulCheckAt) : undefined}
        badgeId={a.tokenAddress} evidenceUrl={c?.evidenceUrl ?? undefined} simulated={c?.simulated}
        established={c?.established.length ? c.established : ["Nothing has been checked yet"]} notEstablished={c?.notEstablished ?? ["Product quality", "Business registration", "Ability to fulfil orders", "Solvency", "Endorsement by Concordium"]} />

      <div className="flex flex-wrap gap-3">
        {canManage && <Button variant="secondary" pending={check.isPending} disabled={!a.checksAvailable} onClick={() => check.mutate()}>Check now</Button>}
        {canManage && !challenge && <Button variant="secondary" pending={getChallenge.isPending} onClick={() => getChallenge.mutate()}>{a.ownerAccount ? "Prove ownership again" : "Prove ownership"}</Button>}
        {canAuthorise && !a.authority.bound && <Button disabled={!a.ownerAccount} onClick={() => setConfirm("authorise")}>Authorise this agent to quote for {org.name}</Button>}
        {canAuthorise && a.authority.bound && <Button variant="ghost" onClick={() => setConfirm("withdraw")}>Withdraw authority</Button>}
      </div>
      {canAuthorise && !a.ownerAccount && <p className="text-xs text-text-muted">Authorising needs a proven owner first.</p>}
      {!canAuthorise && canManage && <p className="text-xs text-text-muted">Only the organisation owner can authorise an agent to quote for the organisation.</p>}
      {!a.checksAvailable && <p className="text-xs text-text-muted">Checks are not available in this environment.</p>}

      {challenge && (
        <form className="grid gap-3 rounded-control border border-border p-4" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (account.trim() && !sigBad && parsed) prove.mutate(); }}>
          <h3 className="font-semibold">Sign this message with the owning account</h3>
          <p className="text-sm text-text-muted">Open your Concordium wallet and use its "sign message" function with the account that owns this agent, then paste the account address and the signature it returns. Never share a seed phrase or private key; this message cannot move funds. It expires {fmtDate(challenge.expiresAt)}.</p>
          <Textarea aria-label="Message to sign" readOnly value={challenge.message} className="min-h-40 font-mono text-xs" />
          <Alert tone="attention" title="Not yet tested with a real wallet app">The server check is tested with signatures made by the official SDK. A browser-wallet connection is not built, so this step is manual.</Alert>
          <Field label="Owner account address" error={touched && !account.trim() ? "Paste the account that owns the agent" : undefined}>{(x) => <Input {...x} autoComplete="off" spellCheck={false} value={account} onChange={(e) => setAccount(e.target.value)} />}</Field>
          <Field label="Signature (as JSON)" hint='Looks like {"0":{"0":"…128 hex characters…"}}' error={touched && (sigBad || !sig.trim()) ? "Paste the signature object your wallet returned" : undefined}>{(x) => <Textarea {...x} spellCheck={false} value={sig} onChange={(e) => setSig(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-3"><Button type="submit" pending={prove.isPending}>Verify signature</Button><Button type="button" variant="ghost" onClick={() => { setChallenge(null); setTouched(false); }}>Cancel</Button></div>
        </form>
      )}

      <ConfirmDialog open={confirm === "authorise"} title="Authorise this agent?" confirmLabel="Authorise" pending={authorise.isPending} onConfirm={() => authorise.mutate()} onCancel={() => setConfirm(null)}
        body={<><p>You are saying that agent <span className="break-all font-medium">{a.tokenAddress}</span> may quote on behalf of <strong>{org.name}</strong>.</p><p className="mt-2">This is recorded separately from the agent's identity. If the agent's owner changes, this authority stops counting until you grant it again.</p></>} />
      <ConfirmDialog open={confirm === "withdraw"} danger title="Withdraw authority?" confirmLabel="Withdraw" pending={withdraw.isPending} onConfirm={() => withdraw.mutate()} onCancel={() => setConfirm(null)}
        body="Quotes from this agent will no longer qualify for buyers' verified lane. Existing orders are not affected." />
    </Card>
  );
}
