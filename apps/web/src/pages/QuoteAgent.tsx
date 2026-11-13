import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type OrgSummary } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, Checkbox, EmptyState, Field, Input, PageTitle, Select, Skeleton } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { isMoney, mayDo, minorToMajor } from "../format";

interface Cfg { enabled: boolean; agentId: string | null; markupBps: number; validityHours: number; deliveryLeadHours: number; deliveryChargeMinor: string; taxBps: number; allowedProductIds: string[]; requireHumanReview: boolean }
interface View { config: Cfg; agents: Array<{ id: string; tokenAddress: string; network: string; operatorType: string; authorised: boolean }>; products: Array<{ id: string; name: string; unit: string }>; note: string }

const pct = (bps: number) => (bps / 100).toFixed(2);
const toBps = (s: string) => Math.round(Number(s) * 100);
const validPct = (s: string, min: number, max: number) => /^-?\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) * 100 >= min && Number(s) * 100 <= max;
const validInt = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

export function QuoteAgentSettings() {
  const { org } = useOutletContext<ShellContext>();
  const q = useQuery({ queryKey: ["quote-agent", org?.id], enabled: !!org?.capabilities.includes("supplier"), queryFn: () => api<View>("GET", `/orgs/${org!.id}/quote-agent`) });
  if (org && !org.capabilities.includes("supplier")) return <Alert tone="attention" title="Supplying is not enabled for this organisation">Switch to a supplying organisation to use this page.</Alert>;
  if (!org || q.isLoading || (!q.data && !q.isError)) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <Alert tone="danger" title="Could not load the quote agent" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>;
  return <Form org={org} view={q.data!} />;
}

function Form({ org, view }: { org: OrgSummary; view: View }) {
  const qc = useQueryClient();
  const c = view.config; const canEdit = mayDo(org, "catalogue.manage"); const isOwner = mayDo(org, "agent.authorise");
  const [enabled, setEnabled] = useState(c.enabled); const [agentId, setAgentId] = useState(c.agentId ?? "");
  const [markup, setMarkup] = useState(pct(c.markupBps)); const [tax, setTax] = useState(pct(c.taxBps));
  const [validity, setValidity] = useState(String(c.validityHours)); const [lead, setLead] = useState(String(c.deliveryLeadHours));
  const [delivery, setDelivery] = useState(minorToMajor(c.deliveryChargeMinor)); const [allowed, setAllowed] = useState(new Set(c.allowedProductIds));
  const [review, setReview] = useState(c.requireHumanReview);
  const [touched, setTouched] = useState(false); const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const authorised = view.agents.filter((a) => a.authorised);

  const bad = {
    markup: !validPct(markup, -1000, 5000), tax: !validPct(tax, 0, 3000), validity: !validInt(validity, 1, 168), lead: !validInt(lead, 1, 336), delivery: !isMoney(delivery),
    agent: enabled && !authorised.some((a) => a.id === agentId), products: enabled && allowed.size === 0,
  };
  const save = useMutation({
    mutationFn: () => api("PUT", `/orgs/${org.id}/quote-agent`, {
      enabled, agentId: agentId || null, markupBps: toBps(markup), validityHours: Number(validity), deliveryLeadHours: Number(lead), deliveryCharge: delivery, taxBps: toBps(tax), allowedProductIds: [...allowed], requireHumanReview: review,
    }),
    onSuccess: async () => { setMsg({ tone: "success", text: "Quote agent settings saved." }); await qc.invalidateQueries({ queryKey: ["quote-agent", org.id] }); },
    onError: (e) => setMsg({ tone: "danger", text: (e as ApiError).message }),
  });
  const toggle = (id: string) => setAllowed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="grid max-w-3xl gap-6">
      <PageTitle title="Quote agent" sub="Prepares quote drafts from your catalogue and the rules below. It is rule-based: no AI model sets, adjusts or explains a price, and it refuses rather than guesses." />
      {msg && <Alert tone={msg.tone} title={msg.text} />}
      <Card className="grid gap-4">
        <Checkbox label="Switch the quote agent on" hint="Needs one of your agents that your organisation has authorised." checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
        <Field label="Agent that quotes for you" hint="Buyers see this agent's identity evidence next to the quote, and whether it is platform-operated." error={touched && bad.agent ? "Choose an authorised agent" : undefined}>
          {(a) => (
            <Select {...a} value={agentId} disabled={!canEdit} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">None</option>
              {view.agents.map((x) => <option key={x.id} value={x.id} disabled={!x.authorised}>{x.tokenAddress}{x.operatorType === "platform_operated" ? " (platform-operated)" : ""}{x.authorised ? "" : " (not authorised)"}</option>)}
            </Select>
          )}
        </Field>
        {view.agents.length === 0 && <EmptyState title="No agents yet" action={<Link className={buttonClasses("secondary")} to="/app/agents">Set up an agent</Link>}>Register an agent, prove who owns it, and authorise it to quote for you. Then come back here.</EmptyState>}

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Products it may quote from</legend>
          {view.products.length === 0 && <p className="text-sm text-text-muted">Add products to your catalogue first.</p>}
          {view.products.map((p) => <Checkbox key={p.id} label={`${p.name} (per ${p.unit})`} checked={allowed.has(p.id)} disabled={!canEdit} onChange={() => toggle(p.id)} />)}
          {touched && bad.products && <p role="alert" className="text-xs text-danger-text">Choose at least one product.</p>}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Markup on your catalogue price (%)" hint="Between -10 and 50. Negative is a discount." error={touched && bad.markup ? "Use a number like 2 or 2.50, from -10 to 50" : undefined}>{(a) => <Input {...a} inputMode="decimal" value={markup} disabled={!canEdit} onChange={(e) => setMarkup(e.target.value)} />}</Field>
          <Field label="Tax (%)" hint="Always stated on the quote, even when 0." error={touched && bad.tax ? "Use a number from 0 to 30" : undefined}>{(a) => <Input {...a} inputMode="decimal" value={tax} disabled={!canEdit} onChange={(e) => setTax(e.target.value)} />}</Field>
          <Field label="Delivery charge (NGN)" hint="A fixed amount, stated explicitly. Use 0 for free delivery." error={touched && bad.delivery ? "Use an amount like 5000 or 0" : undefined}>{(a) => <Input {...a} inputMode="decimal" value={delivery} disabled={!canEdit} onChange={(e) => setDelivery(e.target.value)} />}</Field>
          <Field label="Quote valid for (hours)" hint="1 to 168" error={touched && bad.validity ? "Whole hours from 1 to 168" : undefined}>{(a) => <Input {...a} inputMode="numeric" value={validity} disabled={!canEdit} onChange={(e) => setValidity(e.target.value)} />}</Field>
          <Field label="Delivery lead time (hours)" hint="The agent refuses if this would miss the buyer's deadline." error={touched && bad.lead ? "Whole hours from 1 to 336" : undefined}>{(a) => <Input {...a} inputMode="numeric" value={lead} disabled={!canEdit} onChange={(e) => setLead(e.target.value)} />}</Field>
        </div>

        <Checkbox label="A person reviews every draft before it is submitted (recommended)" hint={isOwner ? "If you turn this off, the agent submits for you under these rules when someone who may submit quotes asks it to." : "Only the organisation owner can turn this off."}
          checked={review} disabled={!canEdit || !isOwner} onChange={(e) => setReview(e.target.checked)} />
        {!review && <Alert tone="attention" title="Human review is off">Quotes the agent prepares will be submitted to buyers without anyone looking at them first.</Alert>}
        {canEdit
          ? <div><Button pending={save.isPending} onClick={() => { setTouched(true); setMsg(null); if (!Object.values(bad).some(Boolean)) save.mutate(); }}>Save quote agent settings</Button></div>
          : <p className="text-sm text-text-muted">Your role can view these settings but not change them.</p>}
        <p className="text-xs text-text-muted">{view.note}</p>
        <div className="flex flex-wrap gap-2"><Badge tone="neutral">Rule-based, no AI model</Badge></div>
      </Card>
    </div>
  );
}
