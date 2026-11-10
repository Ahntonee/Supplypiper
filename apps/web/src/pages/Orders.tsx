import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Alert, AuditTimeline, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, PageTitle, Skeleton, Textarea } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { DISPLAY_QUANTITY, ORDER_STATE } from "../labels";
import { fmtDate } from "../session";

interface OrderRow { id: string; state: string; side: "buyer" | "supplier"; total: string; createdAt: string }
interface Discrepancy { id: string; status: string; buyerReport: { outcome: string; receivedScaled: string | null; orderedScaled: string; note: string | null; at: string } | null; supplierReport: { note: string; quantity: string | null; at: string } | null; resolution: { note: string; at: string } | null }
interface Update { id: string; party: "buyer" | "supplier"; kind: string; quantityScaled: string | null; note: string | null; at: string; discrepancy: Discrepancy | null }
interface OrderDetail {
  id: string; state: string; side: "buyer" | "supplier"; total: string; totalMinor: string; currency: string; buyer: string; supplier: string;
  snapshot: { request: { quantityScaled: string; unit: string; deliverBy: string; destinationAddress: string; destinationArea: string; category: string }; quoteVersion: { version: number; paymentTerms: string | null; deliveryPromisedBy: string | null }; verification: string };
  updates: Update[]; notes: string[];
}

const KIND_TEXT: Record<string, string> = {
  accepted: "accepted the order", declined: "declined the order", preparing: "is preparing the order", dispatched: "dispatched the goods",
  supplier_reports_delivered: "reports the goods were delivered (not yet confirmed by you)", discrepancy_response: "responded to the reported problem",
  cancelled: "cancelled the order", receipt_full: "confirmed everything arrived", receipt_partial: "reported a partial delivery", receipt_problem: "reported a problem",
};

/* ---------------- list ---------------- */
export function Orders() {
  const { org } = useOutletContext<ShellContext>();
  const q = useQuery({ queryKey: ["orders", org?.id], enabled: !!org, queryFn: () => api<{ orders: OrderRow[] }>("GET", `/orgs/${org!.id}/orders`) });
  return (
    <>
      <PageTitle title="Orders" sub="Orders you approved. Supplier acceptance is not proof of delivery; only you confirm receipt." />
      {q.isLoading && <Skeleton className="h-32 w-full" />}
      {q.isError && <Alert tone="danger" title="Could not load orders" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}
      {q.data?.orders.length === 0 && <EmptyState title="No orders yet">When you approve a quote, the order appears here and you can follow it to delivery.</EmptyState>}
      <ul className="grid gap-3">
        {q.data?.orders.map((o) => {
          const s = ORDER_STATE[o.state] ?? { label: o.state, tone: "neutral" as const };
          return (
            <li key={o.id}><Card className="!p-4"><div className="flex flex-wrap items-center justify-between gap-3">
              <div><Link className="font-semibold text-primary underline" to={`/app/orders/${o.id}`}>Order of {o.total}</Link><p className="text-xs text-text-muted">Created {fmtDate(o.createdAt)}</p></div>
              <Badge tone={s.tone}>{s.label}</Badge>
            </div></Card></li>
          );
        })}
      </ul>
    </>
  );
}

/* ---------------- detail ---------------- */
export function OrderDetailPage() {
  const { org } = useOutletContext<ShellContext>();
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["order", org?.id, id], enabled: !!org && !!id, queryFn: () => api<OrderDetail>("GET", `/orgs/${org!.id}/orders/${id}`) });
  const [err, setErr] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<null | "cancel" | "full">(null);
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: ["order", org?.id, id] }), qc.invalidateQueries({ queryKey: ["orders", org?.id] }), qc.invalidateQueries({ queryKey: ["requests", org?.id] })]);
  const post = useMutation({
    mutationFn: (v: { path: string; body?: unknown }) => api("POST", `/orgs/${org!.id}/orders/${id}/${v.path}`, v.body ?? {}),
    onSuccess: async () => { setErr(null); setConfirm(null); await invalidate(); },
    onError: (e) => { setErr(e as ApiError); setConfirm(null); },
  });
  const exp = useMutation({
    mutationFn: () => api("GET", `/orgs/${org!.id}/orders/${id}/export`),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `supplypiper-order-${id}.json`; a.click(); URL.revokeObjectURL(url);
    },
    onError: (e) => setErr(e as ApiError),
  });

  if (q.isLoading || (!q.data && !q.isError)) return <Skeleton className="h-72 w-full" />;
  if (q.isError) return <Alert tone={(q.error as ApiError).status === 404 ? "attention" : "danger"} title={(q.error as ApiError).status === 404 ? "Order not found" : "Could not load this order"} action={(q.error as ApiError).status === 404 ? undefined : <Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>;
  const o = q.data!;
  const st = ORDER_STATE[o.state] ?? { label: o.state, tone: "neutral" as const };
  const openDisc = o.updates.find((u) => u.discrepancy?.status === "open")?.discrepancy ?? null;
  const isBuyer = o.side === "buyer";
  const ordered = DISPLAY_QUANTITY(o.snapshot.request.quantityScaled, o.snapshot.request.unit);

  return (
    <>
      <PageTitle title={`Order of ${o.total}`} sub={`${o.supplier} · ${ordered}`} actions={<Badge tone={st.tone}>{st.label}</Badge>} />
      {err && <div className="mb-4"><Alert tone="danger" title="That didn't work">{err.message}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-6">
          <Card>
            <h2 className="text-lg font-semibold">Order terms (fixed when you approved)</h2>
            <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-text-muted">Supplier</dt><dd>{o.supplier}</dd></div>
              <div><dt className="text-xs text-text-muted">Quote version approved</dt><dd>v{o.snapshot.quoteVersion.version}</dd></div>
              <div><dt className="text-xs text-text-muted">Quantity</dt><dd className="tnum">{ordered}</dd></div>
              <div><dt className="text-xs text-text-muted">Total approved</dt><dd className="tnum font-semibold">{o.total}</dd></div>
              <div><dt className="text-xs text-text-muted">Promised delivery</dt><dd>{o.snapshot.quoteVersion.deliveryPromisedBy ? fmtDate(o.snapshot.quoteVersion.deliveryPromisedBy) : "Not stated"}</dd></div>
              <div><dt className="text-xs text-text-muted">Payment terms</dt><dd>{o.snapshot.quoteVersion.paymentTerms ?? "Not stated"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Delivery address</dt><dd>{o.snapshot.request.destinationAddress}, {o.snapshot.request.destinationArea}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Identity evidence</dt><dd>{o.snapshot.verification}</dd></div>
            </dl>
          </Card>

          {o.updates.some((u) => u.discrepancy) && (
            <Card className="grid gap-4">
              <h2 className="text-lg font-semibold">Reported problem: both sides are kept as written</h2>
              {o.updates.filter((u) => u.discrepancy).map((u) => {
                const d = u.discrepancy!;
                return (
                  <div key={d.id} className="grid gap-3 text-sm sm:grid-cols-2">
                    <div className="rounded-control border border-border p-3"><p className="font-medium">Buyer's report</p>
                      <p>{d.buyerReport?.outcome === "partial" ? `Received ${DISPLAY_QUANTITY(d.buyerReport.receivedScaled ?? "0", o.snapshot.request.unit)} of ${ordered}` : "Reported a problem"}</p>
                      {d.buyerReport?.note && <p className="mt-1 text-text-muted">“{d.buyerReport.note}”</p>}</div>
                    <div className="rounded-control border border-border p-3"><p className="font-medium">Supplier's response</p>
                      {d.supplierReport ? <><p>{d.supplierReport.quantity ? `States ${d.supplierReport.quantity} ${o.snapshot.request.unit} were delivered` : "Responded"}</p><p className="mt-1 text-text-muted">“{d.supplierReport.note}”</p></> : <p className="text-text-muted">No response yet.</p>}</div>
                    {d.resolution && <div className="rounded-control bg-primary-soft p-3 text-primary sm:col-span-2"><p className="font-medium">Closed by you</p><p>“{d.resolution.note}”</p></div>}
                  </div>
                );
              })}
              <p className="text-xs text-text-muted">SupplyPiper does not decide who is right. Closing records your note; it never overwrites either report.</p>
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-lg font-semibold">What has happened</h2>
            <AuditTimeline events={[{ at: "Approved", text: `You approved ${o.total} for this order` }, ...o.updates.map((u) => ({
              at: fmtDate(u.at), text: `${u.party === "buyer" ? "You" : "The supplier"} ${KIND_TEXT[u.kind] ?? u.kind.replaceAll("_", " ")}${u.note ? `: “${u.note}”` : ""}`,
            }))]} />
            <ul className="mt-4 list-disc pl-5 text-xs text-text-muted">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card className="grid gap-3">
            <h2 className="text-lg font-semibold">Your next step</h2>
            {isBuyer && o.state === "awaiting_supplier_acceptance" && <><p className="text-sm text-text-muted">The supplier hasn't accepted yet. You can still cancel.</p><Button variant="secondary" onClick={() => setConfirm("cancel")}>Cancel this order</Button></>}
            {["accepted", "preparing"].includes(o.state) && <p className="text-sm text-text-muted">The supplier has accepted. Changes after acceptance need a change request, which isn't available yet.</p>}
            {o.state === "dispatched" && isBuyer && <><p className="text-sm text-text-muted">Goods are on the way. If something is already wrong you can report it.</p><ReceiptForm only="problem" pending={post.isPending} onSubmit={(b) => post.mutate({ path: "receipt", body: b })} /></>}
            {o.state === "delivered_awaiting_buyer_confirmation" && isBuyer && <ReceiptForm pending={post.isPending} unit={o.snapshot.request.unit} ordered={ordered}
              onSubmit={(b) => (b.outcome === "full" ? setConfirm("full") : post.mutate({ path: "receipt", body: b }))} />}
            {isBuyer && ["issue_reported", "partially_fulfilled"].includes(o.state) && openDisc && <ResolveForm pending={post.isPending} onSubmit={(note) => post.mutate({ path: "discrepancy-resolution", body: { note } })} />}
            {["completed", "declined", "cancelled"].includes(o.state) && <p className="text-sm text-text-muted">Nothing more to do on this order.</p>}
            {o.state === "declined" && isBuyer && <p className="text-sm text-text-muted">The request is open again. <Link className="underline" to="/app/requests">Choose another quote.</Link></p>}
          </Card>
          <Card className="grid gap-2">
            <h2 className="text-lg font-semibold">Evidence summary</h2>
            <p className="text-sm text-text-muted">A concise record of the approved terms, calculation version and every update, for people who need to check it.</p>
            <Button variant="secondary" pending={exp.isPending} onClick={() => exp.mutate()}>Download evidence summary (JSON)</Button>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirm === "cancel"} danger title="Cancel this order?" confirmLabel="Cancel order" pending={post.isPending} body="The supplier hasn't accepted yet, so nothing has been reserved. Your request becomes available for a new approval." onConfirm={() => post.mutate({ path: "cancel" })} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === "full"} title="Confirm everything arrived?" confirmLabel="Yes, it all arrived" pending={post.isPending} body={`This records that you received the full ${ordered} and closes the order. If something is missing, choose "Part of it" or "There's a problem" instead.`} onConfirm={() => post.mutate({ path: "receipt", body: { outcome: "full" } })} onCancel={() => setConfirm(null)} />
    </>
  );
}

function ReceiptForm({ onSubmit, pending, only, unit, ordered }: { onSubmit: (b: { outcome: "full" | "partial" | "problem"; receivedQuantity?: string; note?: string }) => void; pending: boolean; only?: "problem"; unit?: string; ordered?: string }) {
  const [outcome, setOutcome] = useState<"full" | "partial" | "problem">(only ?? "full");
  const [qty, setQty] = useState(""); const [note, setNote] = useState(""); const [touched, setTouched] = useState(false);
  const qtyBad = outcome === "partial" && !/^\d+(\.\d{1,6})?$/.test(qty);
  const noteBad = outcome !== "full" && note.trim().length === 0;
  return (
    <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (qtyBad || noteBad) return; onSubmit({ outcome, receivedQuantity: outcome === "partial" ? qty : undefined, note: note.trim() || undefined }); }}>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">{only ? "Report a problem" : "Did the delivery arrive?"}</legend>
        {!only && (<>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="outcome" checked={outcome === "full"} onChange={() => setOutcome("full")} className="size-5 accent-[var(--primary)]" />Yes, all of it{ordered ? ` (${ordered})` : ""}</label>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="outcome" checked={outcome === "partial"} onChange={() => setOutcome("partial")} className="size-5 accent-[var(--primary)]" />Part of it</label>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="outcome" checked={outcome === "problem"} onChange={() => setOutcome("problem")} className="size-5 accent-[var(--primary)]" />There's a problem</label>
        </>)}
      </fieldset>
      {outcome === "partial" && <Field label={`How much arrived (${unit ?? ""})`} error={touched && qtyBad ? "Enter the quantity received, like 30" : undefined}>{(a) => <Input {...a} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>}
      {outcome !== "full" && <Field label="What happened" hint="The supplier will see this and can respond. Both versions are kept." error={touched && noteBad ? "Describe what went wrong" : undefined}>{(a) => <Textarea {...a} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
      <Button type="submit" pending={pending}>{outcome === "full" ? "Confirm receipt" : "Send report"}</Button>
    </form>
  );
}

function ResolveForm({ onSubmit, pending }: { onSubmit: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState(""); const [touched, setTouched] = useState(false);
  return (
    <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (note.trim()) onSubmit(note.trim()); }}>
      <p className="text-sm text-text-muted">When you've agreed an outcome with the supplier, record it here to close the order. Both reports stay as written.</p>
      <Field label="How it was settled" error={touched && !note.trim() ? "Write a short note" : undefined}>{(a) => <Textarea {...a} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <Button type="submit" pending={pending}>Close with this note</Button>
    </form>
  );
}
