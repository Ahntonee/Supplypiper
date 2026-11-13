import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { UnitCode } from "@supplypiper/domain";
import { api, ApiError, type OrgSummary } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, Checkbox, ConfirmDialog, EmptyState, Field, Input, Money, PageTitle, Select, Skeleton } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { goodsFrom, isMoney, isQty, landedMinor, mayDo, minorToMajor, toLocalInput } from "../format";
import { DISPLAY_QUANTITY } from "../labels";
import { fmtDate, userTimezone } from "../session";
import { useProducts, useProfile } from "./SupplierSetup";

interface InboxRequest { id: string; buyer: string; category: string; quantityScaled: string; unit: string; deliverBy: string; deliverTz: string; destinationArea: string; destinationAddress: string; responseDeadline: string | null; state: string; myQuoteState: string }
interface Charge { kind: "delivery" | "tax" | "fee"; label: string; amountMinor: string | null; mandatory: boolean }
interface Version { id: string; quoteId: string; version: number; productId: string | null; category: string; offeredScaled: string; offeredUnit: UnitCode; unitPriceMinor: string; priceUnit: UnitCode; goodsTotalMinor: string; charges: Charge[]; validUntil: string; deliveryPromisedBy: string | null; paymentTerms: string | null; deliversToArea: boolean; submittedAt: string | null }
interface QuoteData { quote: { id: string; state: string; versions: Version[] } | null }

const QUOTE_LABEL: Record<string, string> = { "no quote yet": "No quote yet", draft: "Draft only", submitted: "Quote submitted", withdrawn: "Withdrawn" };

/* ---------------- inbox list ---------------- */
export function Inbox() {
  const { org } = useOutletContext<ShellContext>();
  const q = useQuery({ queryKey: ["inbox", org?.id], enabled: !!org?.capabilities.includes("supplier"), queryFn: () => api<{ requests: InboxRequest[] }>("GET", `/orgs/${org!.id}/inbox`) });
  const profile = useProfile(org?.id);
  if (org && !org.capabilities.includes("supplier")) return <Alert tone="attention" title="Supplying is not enabled for this organisation">Switch to a supplying organisation to see requests.</Alert>;
  return (
    <>
      <PageTitle title="Requests for quotes" sub="Buyers who have asked your business to quote. You only see requests addressed to you, never other suppliers' quotes or the buyer's budget." />
      {profile.data === null && <div className="mb-4"><Alert tone="attention" title="You aren't listed to buyers yet" action={<Link className={buttonClasses("secondary")} to="/app/profile">Create profile</Link>}>Buyers can only invite suppliers with a profile.</Alert></div>}
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.isError && <Alert tone="danger" title="Could not load requests" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}
      {q.data?.requests.length === 0 && <EmptyState title="No requests yet">When a buyer invites your business to quote, it appears here.</EmptyState>}
      <ul className="grid gap-3">
        {q.data?.requests.map((r) => (
          <li key={r.id}><Card className="!p-4"><div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Link className="font-semibold text-primary underline" to={`/app/inbox/${r.id}`}>{r.category.replaceAll("_", " ")}, {DISPLAY_QUANTITY(r.quantityScaled, r.unit)}</Link>
              <p className="break-words text-sm text-text-muted">From {r.buyer} (name as the buyer entered it) · deliver by {fmtDate(r.deliverBy)} · reply by {r.responseDeadline ? fmtDate(r.responseDeadline) : "not set"}</p>
            </div>
            <Badge tone={r.myQuoteState === "submitted" ? "success" : "neutral"}>{QUOTE_LABEL[r.myQuoteState] ?? r.myQuoteState}</Badge>
          </div></Card></li>
        ))}
      </ul>
    </>
  );
}

/* ---------------- request + quote builder ---------------- */
const unitEnum = z.enum(["L", "mL", "kg", "g", "each"]);
const feeSchema = z.object({ label: z.string().trim().min(1, "Name this fee").max(80), amount: z.string(), unknown: z.boolean(), mandatory: z.boolean() });
const quoteSchema = z.object({
  productId: z.string(), category: z.string().min(1), offeredQuantity: z.string().refine(isQty, "Use a number like 40").refine((v) => Number(v) > 0, "Must be more than zero"), offeredUnit: unitEnum,
  unitPrice: z.string().refine(isMoney, "Use an amount like 2500 or 2500.50"), priceUnit: unitEnum, goodsTotal: z.string().refine(isMoney, "Use an amount like 100000.00"),
  deliveryAmount: z.string(), deliveryUnknown: z.boolean(), taxAmount: z.string(), taxUnknown: z.boolean(), fees: z.array(feeSchema).max(10),
  validUntil: z.string().min(1, "Say how long this quote is valid").refine((v) => new Date(v).getTime() > Date.now(), "Must be in the future"),
  deliveryPromisedBy: z.string(), paymentTerms: z.string().max(200), deliversToArea: z.boolean(),
}).superRefine((v, ctx) => {
  if (!v.deliveryUnknown && !isMoney(v.deliveryAmount)) ctx.addIssue({ code: "custom", path: ["deliveryAmount"], message: "Enter the delivery charge, or 0 if there is none" });
  if (!v.taxUnknown && !isMoney(v.taxAmount)) ctx.addIssue({ code: "custom", path: ["taxAmount"], message: "Enter the tax, or 0 if there is none" });
  v.fees.forEach((f, i) => { if (!f.unknown && !isMoney(f.amount)) ctx.addIssue({ code: "custom", path: ["fees", i, "amount"], message: "Enter an amount, like 500" }); });
});
type QuoteForm = z.infer<typeof quoteSchema>;

const amountOrBlank = (c: Charge | undefined) => (c && c.amountMinor !== null ? minorToMajor(c.amountMinor) : "");

export function InboxRequest() {
  const { org } = useOutletContext<ShellContext>();
  const { requestId } = useParams();
  const req = useQuery({ queryKey: ["inbox-request", org?.id, requestId], enabled: !!org && !!requestId, queryFn: () => api<InboxRequest>("GET", `/orgs/${org!.id}/inbox/${requestId}`) });
  const quote = useQuery({ queryKey: ["my-quote", org?.id, requestId], enabled: !!org && !!requestId, queryFn: () => api<QuoteData>("GET", `/orgs/${org!.id}/requests/${requestId}/quotes`) });
  const products = useProducts(org?.id, !!org);
  if (!org || req.isLoading || quote.isLoading || products.isLoading || (!req.data && !req.isError) || (!quote.data && !quote.isError)) return <Skeleton className="h-96 w-full" />;
  if (req.isError) return <Alert tone={(req.error as ApiError).status === 404 ? "attention" : "danger"} title={(req.error as ApiError).status === 404 ? "Request not found" : "Could not load this request"} action={(req.error as ApiError).status === 404 ? undefined : <Button variant="secondary" onClick={() => req.refetch()}>Retry</Button>}>{(req.error as ApiError).status === 404 ? "It may not have been addressed to your organisation." : (req.error as ApiError).message}</Alert>;
  const r = req.data!;
  const open = ["published", "collecting"].includes(r.state) && (!r.responseDeadline || new Date(r.responseDeadline) > new Date());
  return (
    <>
      <PageTitle title={`${r.category.replaceAll("_", " ")}, ${DISPLAY_QUANTITY(r.quantityScaled, r.unit)}`} sub={`Requested by ${r.buyer} (name as entered by the buyer).`} actions={<Link className={buttonClasses("secondary")} to="/app/inbox">All requests</Link>} />
      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="content-start">
          <h2 className="text-lg font-semibold">What the buyer asked</h2>
          <dl className="mt-3 grid gap-3 text-sm">
            <div><dt className="text-xs text-text-muted">Quantity</dt><dd className="tnum">{DISPLAY_QUANTITY(r.quantityScaled, r.unit)}</dd></div>
            <div><dt className="text-xs text-text-muted">Deliver by</dt><dd>{fmtDate(r.deliverBy)} ({r.deliverTz})</dd></div>
            <div><dt className="text-xs text-text-muted">Deliver to</dt><dd className="break-words">{r.destinationAddress}, {r.destinationArea}</dd></div>
            <div><dt className="text-xs text-text-muted">Reply by</dt><dd>{r.responseDeadline ? fmtDate(r.responseDeadline) : "Not set"}</dd></div>
          </dl>
          <p className="mt-3 rounded-control bg-primary-soft p-2 text-xs text-primary">The buyer's budget and other suppliers' quotes are never shown to you.</p>
        </Card>
        <div className="grid min-w-0 gap-6">
          {!open && <Alert tone="attention" title="This request is no longer taking quotes">{r.state === "published" || r.state === "collecting" ? "The reply deadline has passed." : `It is ${r.state.replaceAll("_", " ")}.`} Your earlier versions are kept below.</Alert>}
          {open && org && <PrepareWithAgent org={org} requestId={r.id} />}
          {open && org && <QuoteBuilder org={org} request={r} products={products.data ?? []} versions={quote.data?.quote?.versions ?? []} quoteState={quote.data?.quote?.state} quoteId={quote.data?.quote?.id} />}
          <History versions={quote.data?.quote?.versions ?? []} quoteState={quote.data?.quote?.state} quoteId={quote.data?.quote?.id} org={org} requestId={r.id} open={open} />
        </div>
      </div>
    </>
  );
}

function PrepareWithAgent({ org, requestId }: { org: OrgSummary; requestId: string }) {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["quote-agent", org.id], queryFn: () => api<{ config: { enabled: boolean; requireHumanReview: boolean } }>("GET", `/orgs/${org.id}/quote-agent`) });
  const [result, setResult] = useState<{ tone: "success" | "attention" | "danger"; title: string; lines: string[] } | null>(null);
  const prepare = useMutation({
    mutationFn: () => api<{ submitted: boolean; notice: string; report: string[] }>("POST", `/orgs/${org.id}/requests/${requestId}/agent-draft`, {}),
    onSuccess: async (r) => {
      setResult({ tone: "success", title: r.notice, lines: r.report });
      await Promise.all([qc.invalidateQueries({ queryKey: ["my-quote", org.id, requestId] }), qc.invalidateQueries({ queryKey: ["inbox", org.id] }), qc.invalidateQueries({ queryKey: ["inbox-request", org.id, requestId] })]);
    },
    onError: (e) => { const x = e as ApiError; setResult({ tone: x.code === "AGENT_REFUSED" ? "attention" : "danger", title: x.message, lines: Object.values(x.details) }); },
  });
  if (!mayDo(org, "quote.draft") || cfg.isLoading || !cfg.data) return null;
  if (!cfg.data.config.enabled) return <p className="text-sm text-text-muted">Your quote agent is off. <Link className="font-medium text-primary underline" to="/app/quote-agent">Set it up</Link> to prepare drafts from your catalogue.</p>;
  return (
    <Card className="grid gap-3">
      <h2 className="text-lg font-semibold">Quote agent</h2>
      <p className="text-sm text-text-muted">Prepares a draft from your catalogue and your rules. No AI model sets the price.{cfg.data.config.requireHumanReview ? " You review it before it goes to the buyer." : " Human review is off: it will be submitted for you."}</p>
      <div><Button variant="secondary" pending={prepare.isPending} onClick={() => { setResult(null); prepare.mutate(); }}>Prepare a draft with the quote agent</Button></div>
      {result && <Alert tone={result.tone} title={result.title}>{result.lines.length > 0 && <ul className="mt-1 list-disc pl-5">{result.lines.map((l) => <li key={l}>{l}</li>)}</ul>}</Alert>}
    </Card>
  );
}

function QuoteBuilder({ org, request, products, versions }: { org: OrgSummary; request: InboxRequest; products: Array<{ id: string; unit: string; category: string; unitPriceMinor: string }>; versions: Version[]; quoteState: string | undefined; quoteId: string | undefined }) {
  const qc = useQueryClient();
  const tz = userTimezone();
  const last = versions[versions.length - 1];
  const canSubmit = mayDo(org, "quote.submit");
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const futureOr = (iso: string | null | undefined) => (iso && new Date(iso) > new Date() ? toLocalInput(iso) : "");
  const deliveryC = last?.charges.find((c) => c.kind === "delivery"); const taxC = last?.charges.find((c) => c.kind === "tax");
  const { register, handleSubmit, setValue, getValues, control, formState: { errors } } = useForm<QuoteForm>({
    resolver: zodResolver(quoteSchema), mode: "onTouched",
    defaultValues: {
      productId: last?.productId ?? "", category: request.category, offeredQuantity: last ? DISPLAY_QUANTITY(last.offeredScaled, last.offeredUnit).split(" ")[0]! : DISPLAY_QUANTITY(request.quantityScaled, request.unit).split(" ")[0]!, offeredUnit: (last?.offeredUnit ?? request.unit) as UnitCode,
      unitPrice: last ? minorToMajor(last.unitPriceMinor) : "", priceUnit: (last?.priceUnit ?? request.unit) as UnitCode, goodsTotal: last ? minorToMajor(last.goodsTotalMinor) : "",
      deliveryAmount: amountOrBlank(deliveryC), deliveryUnknown: !!deliveryC && deliveryC.amountMinor === null, taxAmount: amountOrBlank(taxC), taxUnknown: !!taxC && taxC.amountMinor === null,
      fees: (last?.charges ?? []).filter((c) => c.kind === "fee").map((c) => ({ label: c.label, amount: amountOrBlank(c), unknown: c.amountMinor === null, mandatory: c.mandatory })),
      validUntil: futureOr(last?.validUntil), deliveryPromisedBy: futureOr(last?.deliveryPromisedBy), paymentTerms: last?.paymentTerms ?? "", deliversToArea: last?.deliversToArea ?? false,
    },
  });
  const fees = useFieldArray({ control, name: "fees" });
  const w = useWatch({ control });
  const landed = landedMinor(w.goodsTotal ?? "", { amount: w.deliveryAmount ?? "", unknown: !!w.deliveryUnknown }, { amount: w.taxAmount ?? "", unknown: !!w.taxUnknown }, (w.fees ?? []).map((f) => ({ amount: f?.amount ?? "", unknown: !!f?.unknown, mandatory: !!f?.mandatory })));

  const save = useMutation({
    mutationFn: (v: { form: QuoteForm; submit: boolean }) => api("POST", `/orgs/${org.id}/requests/${request.id}/quotes`, {
      productId: v.form.productId || undefined, category: v.form.category, offeredQuantity: v.form.offeredQuantity, offeredUnit: v.form.offeredUnit,
      unitPrice: v.form.unitPrice, priceUnit: v.form.priceUnit, goodsTotal: v.form.goodsTotal,
      charges: [
        { kind: "delivery", label: "Delivery", amount: v.form.deliveryUnknown ? null : v.form.deliveryAmount, mandatory: true },
        { kind: "tax", label: "Tax", amount: v.form.taxUnknown ? null : v.form.taxAmount, mandatory: true },
        ...v.form.fees.map((f) => ({ kind: "fee", label: f.label, amount: f.unknown ? null : f.amount, mandatory: f.mandatory })),
      ],
      validUntil: new Date(v.form.validUntil).toISOString(), deliveryPromisedBy: v.form.deliveryPromisedBy ? new Date(v.form.deliveryPromisedBy).toISOString() : undefined, deliveryTz: tz,
      paymentTerms: v.form.paymentTerms || undefined, deliversToArea: v.form.deliversToArea, submit: v.submit,
    }),
    onSuccess: async (_r, v) => {
      setMsg({ tone: "success", text: v.submit ? "Quote submitted as a new version. The buyer can now see it." : "Draft saved. The buyer cannot see it until a manager submits it." });
      await Promise.all([qc.invalidateQueries({ queryKey: ["my-quote", org.id, request.id] }), qc.invalidateQueries({ queryKey: ["inbox", org.id] }), qc.invalidateQueries({ queryKey: ["inbox-request", org.id, request.id] })]);
    },
    onError: (e) => setMsg({ tone: "danger", text: (e as ApiError).message }),
  });
  const run = (submit: boolean) => handleSubmit((form) => {
    setMsg(null);
    if (submit && !form.deliveryPromisedBy) { setMsg({ tone: "danger", text: "Add a delivery commitment (a date and time) before submitting." }); return; }
    save.mutate({ form, submit });
  });

  const pickProduct = (id: string) => {
    setValue("productId", id);
    const p = products.find((x) => x.id === id);
    const v = { shouldValidate: true }; // re-validate so an earlier "empty" error does not linger on a value we just filled in
    if (p) { setValue("category", p.category, v); setValue("priceUnit", p.unit as UnitCode, v); setValue("unitPrice", minorToMajor(p.unitPriceMinor), v); }
  };
  const calc = () => {
    const g = goodsFrom(getValues("unitPrice"), getValues("offeredQuantity"), getValues("offeredUnit"), getValues("priceUnit"));
    if (g) setValue("goodsTotal", g, { shouldValidate: true }); else setMsg({ tone: "danger", text: "Can't calculate: enter a unit price and quantity, and use compatible units (litres and kilograms never convert)." });
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">{versions.length ? `Revise your quote (next version: v${versions.length + 1})` : "Your quote"}</h2>
      <p className="mt-1 text-sm text-text-muted">Every number you enter is shown to the buyer as your statement. Submitted versions can't be edited; revising creates a new version.</p>
      {msg && <div className="mt-3"><Alert tone={msg.tone} title={msg.text} /></div>}
      <form className="mt-4 grid gap-5" noValidate onSubmit={run(canSubmit)}>
        <Field label="Product from your catalogue" hint="Optional. Choosing one ties your quote to your declared stock; it's checked when the order is approved and reserved when you accept.">
          {(a) => <Select {...a} value={w.productId ?? ""} onChange={(e) => pickProduct(e.target.value)}><option value="">None (quote without a catalogue product)</option>{products.map((p) => <option key={p.id} value={p.id}>{p.category.replaceAll("_", " ")} per {p.unit}</option>)}</Select>}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity you can supply" error={errors.offeredQuantity?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("offeredQuantity")} />}</Field>
          <Field label="Unit">{(a) => <Select {...a} {...register("offeredUnit")}><option>L</option><option>mL</option><option>kg</option><option>g</option><option>each</option></Select>}</Field>
          <Field label="Price per unit (NGN)" error={errors.unitPrice?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("unitPrice")} />}</Field>
          <Field label="Price is per">{(a) => <Select {...a} {...register("priceUnit")}><option>L</option><option>mL</option><option>kg</option><option>g</option><option>each</option></Select>}</Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Goods total (NGN)" hint="Must agree with price × quantity, within one kobo." error={errors.goodsTotal?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("goodsTotal")} />}</Field>
          <Button type="button" variant="secondary" onClick={calc}>Calculate from price</Button>
        </div>

        <fieldset className="grid gap-4 rounded-control border border-border p-4">
          <legend className="px-1 text-sm font-medium">Charges. Zero must be stated, not left blank.</legend>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Delivery (NGN)" error={errors.deliveryAmount?.message}>{(a) => <Input {...a} inputMode="decimal" disabled={!!w.deliveryUnknown} {...register("deliveryAmount")} />}</Field>
            <Checkbox label="Not known yet" {...register("deliveryUnknown")} />
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Tax (NGN)" error={errors.taxAmount?.message}>{(a) => <Input {...a} inputMode="decimal" disabled={!!w.taxUnknown} {...register("taxAmount")} />}</Field>
            <Checkbox label="Not known yet" {...register("taxUnknown")} />
          </div>
          {fees.fields.map((f, i) => (
            <div key={f.id} className="grid gap-2 rounded-control bg-canvas p-3 sm:grid-cols-2">
              <Field label={`Other charge ${i + 1}: name`} error={errors.fees?.[i]?.label?.message}>{(a) => <Input {...a} {...register(`fees.${i}.label` as const)} />}</Field>
              <Field label="Amount (NGN)" error={errors.fees?.[i]?.amount?.message}>{(a) => <Input {...a} inputMode="decimal" disabled={!!w.fees?.[i]?.unknown} {...register(`fees.${i}.amount` as const)} />}</Field>
              <Checkbox label="Required to buy" {...register(`fees.${i}.mandatory` as const)} />
              <div className="flex flex-wrap items-center gap-3"><Checkbox label="Not known yet" {...register(`fees.${i}.unknown` as const)} /><Button type="button" variant="ghost" onClick={() => fees.remove(i)}>Remove<span className="sr-only"> other charge {i + 1}</span></Button></div>
            </div>
          ))}
          <div><Button type="button" variant="secondary" onClick={() => fees.append({ label: "", amount: "", unknown: false, mandatory: true })}>Add another charge</Button></div>
          {(w.deliveryUnknown || w.taxUnknown || w.fees?.some((f) => f?.unknown && f.mandatory)) && <Alert tone="attention" title="A required charge is marked unknown">The buyer's comparison will leave this quote out because its landed total can't be calculated.</Alert>}
        </fieldset>

        <div className="rounded-control bg-primary-soft p-3">
          <p className="text-sm text-primary">Landed total the buyer will see</p>
          <p className="tnum text-[24px] font-semibold text-primary">{landed === null ? "Incomplete" : <Money minor={landed} currency="NGN" />}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="This quote is valid until" hint={`Your timezone: ${tz}`} error={errors.validUntil?.message}>{(a) => <Input {...a} type="datetime-local" {...register("validUntil")} />}</Field>
          <Field label="Delivery promised by" hint={`Needed to submit. The buyer's deadline: ${fmtDate(request.deliverBy)}.`}>{(a) => <Input {...a} type="datetime-local" {...register("deliveryPromisedBy")} />}</Field>
        </div>
        <Field label="Payment terms">{(a) => <Input {...a} {...register("paymentTerms")} />}</Field>
        <Checkbox label={`We deliver to ${request.destinationArea}`} hint="If this isn't ticked, the buyer's comparison will leave your quote out." {...register("deliversToArea")} />

        <div className="flex flex-wrap gap-3">
          {canSubmit && <Button type="submit" pending={save.isPending && save.variables?.submit === true}>Submit quote</Button>}
          <Button type="button" variant={canSubmit ? "secondary" : "primary"} pending={save.isPending && save.variables?.submit === false} onClick={run(false)}>Save draft</Button>
        </div>
        {!canSubmit && <p className="text-xs text-text-muted">Your role can save drafts. A supplier manager submits them.</p>}
      </form>
    </Card>
  );
}

function History({ versions, quoteState, quoteId, org, requestId, open }: { versions: Version[]; quoteState: string | undefined; quoteId: string | undefined; org: OrgSummary; requestId: string; open: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<ApiError | null>(null);
  const [confirmW, setConfirmW] = useState(false);
  const canSubmit = mayDo(org, "quote.submit");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["my-quote", org.id, requestId] }), qc.invalidateQueries({ queryKey: ["inbox", org.id] }), qc.invalidateQueries({ queryKey: ["inbox-request", org.id, requestId] })]);
  const submit = useMutation({ mutationFn: (v: Version) => api("POST", `/orgs/${org.id}/quotes/${quoteId}/versions/${v.id}/submit`, {}), onSuccess: async () => { setErr(null); await refresh(); }, onError: (e) => setErr(e as ApiError) });
  const withdraw = useMutation({ mutationFn: () => api("POST", `/orgs/${org.id}/quotes/${quoteId}/withdraw`, {}), onSuccess: async () => { setErr(null); setConfirmW(false); await refresh(); }, onError: (e) => { setErr(e as ApiError); setConfirmW(false); } });
  if (versions.length === 0) return null;
  const latestSubmitted = [...versions].reverse().find((v) => v.submittedAt)?.id;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-semibold">Your versions</h2>{quoteState === "withdrawn" && <Badge tone="danger">Withdrawn</Badge>}
        {canSubmit && quoteState === "submitted" && open && <Button variant="ghost" onClick={() => setConfirmW(true)}>Withdraw quote</Button>}</div>
      {err && <div className="mt-3"><Alert tone="danger" title="That didn't work">{err.message}</Alert></div>}
      <ul className="mt-3 divide-y divide-border">
        {[...versions].reverse().map((v) => {
          const total = landedMinor(minorToMajor(v.goodsTotalMinor),
            { amount: amountOrBlank(v.charges.find((c) => c.kind === "delivery")), unknown: v.charges.find((c) => c.kind === "delivery")?.amountMinor == null },
            { amount: amountOrBlank(v.charges.find((c) => c.kind === "tax")), unknown: v.charges.find((c) => c.kind === "tax")?.amountMinor == null },
            v.charges.filter((c) => c.kind === "fee").map((c) => ({ amount: amountOrBlank(c), unknown: c.amountMinor === null, mandatory: c.mandatory })));
          const state = !v.submittedAt ? "Draft" : v.id === latestSubmitted && quoteState !== "withdrawn" ? "Current" : "Superseded";
          return (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div><p className="font-medium">v{v.version} <Badge tone={state === "Current" ? "success" : state === "Draft" ? "attention" : "neutral"}>{state}</Badge></p>
                <p className="text-text-muted">{total === null ? "Landed total incomplete" : <>Landed <Money minor={total} currency="NGN" /></>} · valid until {fmtDate(v.validUntil)}{v.submittedAt ? ` · submitted ${fmtDate(v.submittedAt)}` : ""}</p></div>
              {!v.submittedAt && canSubmit && open && <Button variant="secondary" pending={submit.isPending} onClick={() => submit.mutate(v)}>Submit this draft<span className="sr-only"> v{v.version}</span></Button>}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog open={confirmW} danger title="Withdraw this quote?" confirmLabel="Withdraw quote" pending={withdraw.isPending} body="The buyer will no longer be able to choose it. Withdrawing doesn't affect an order already created from it." onConfirm={() => withdraw.mutate()} onCancel={() => setConfirmW(false)} />
    </Card>
  );
}
