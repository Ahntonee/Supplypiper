import { useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, ConfirmDialog, PageTitle, Skeleton } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { APPROVAL_REJECTION, DISPLAY_QUANTITY } from "../labels";
import { fmtDate } from "../session";

interface Summary {
  intentId: string; status: "open" | "used" | "expired" | "changed"; expiresAt: string; orderId: string | null; supplier: string; requestId: string;
  quoteVersion: number; quoteSource: string; verification: string; item: { category: string; quantityScaled: string; unit: string };
  goods: string; charges: Array<{ kind: string; label: string; amount: string; mandatory: boolean }>; totalMinor: string; total: string;
  quoteValidUntil: string; deliveryPromisedBy: string | null; deliveryTz: string | null; deliveryTo: string; paymentTerms: string; buttonLabel: string; consequence: string;
}

export function Approval() {
  const { org } = useOutletContext<ShellContext>();
  const { intentId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rejection, setRejection] = useState<ApiError | null>(null);
  const q = useQuery({ queryKey: ["approval", org?.id, intentId], enabled: !!org && !!intentId, queryFn: () => api<Summary>("GET", `/orgs/${org!.id}/approvals/${intentId}`) });
  const confirm = useMutation({
    mutationFn: () => api<{ orderId: string }>("POST", `/orgs/${org!.id}/approvals/${intentId}/confirm`, { expectedTotalMinor: q.data!.totalMinor }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ["orders", org?.id] }); await qc.invalidateQueries({ queryKey: ["requests", org?.id] }); nav(`/app/orders/${r.orderId}`); },
    onError: (e) => { setOpen(false); setRejection(e as ApiError); qc.invalidateQueries({ queryKey: ["approval", org?.id, intentId] }); },
  });

  if (q.isLoading || (!q.data && !q.isError)) return <Skeleton className="h-72 w-full" />;
  if (q.isError) return <Alert tone={(q.error as ApiError).status === 404 ? "attention" : "danger"} title={(q.error as ApiError).status === 404 ? "Approval not found" : "Could not load this approval"} action={(q.error as ApiError).status === 404 ? undefined : <Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>;
  const a = q.data!;
  const reasons = rejection?.details.reasons?.split(",").filter(Boolean) ?? [];
  const usable = a.status === "open";
  const back = `/app/requests/${a.requestId}/compare`;

  return (
    <div className="max-w-3xl">
      <PageTitle title="Review before you approve" sub="Check every line. Approving covers exactly this quote version and this total, nothing else." />

      {rejection && (
        <div className="mb-4"><Alert tone="danger" title={rejection.code === "APPROVAL_REJECTED" ? "Not approved: something changed" : "Not approved"}>
          {rejection.code === "APPROVAL_REJECTED" ? <>
            <ul className="mt-1 list-disc pl-5">{reasons.map((c) => <li key={c}>{APPROVAL_REJECTION[c] ?? c}</li>)}</ul>
            <p className="mt-2">No order was created and no money moved. <Link className="font-medium underline" to={back}>Review the current quotes</Link> to get a fresh approval.</p>
          </> : <p>{rejection.message}</p>}
        </Alert></div>
      )}
      {a.status === "used" && <div className="mb-4"><Alert tone="success" title="This approval was already used">{a.orderId && <Link className="underline" to={`/app/orders/${a.orderId}`}>View the order</Link>}</Alert></div>}
      {a.status === "expired" && <div className="mb-4"><Alert tone="attention" title="This approval has expired">Approvals last 15 minutes. <Link className="font-medium underline" to={back}>Go back to the comparison</Link> to prepare a new one.</Alert></div>}
      {a.status === "changed" && !rejection && <div className="mb-4"><Alert tone="attention" title="The quote has changed since this review">The supplier replaced or withdrew it. <Link className="font-medium underline" to={back}>Review the current quotes</Link>.</Alert></div>}

      <Card className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-xl font-semibold">{a.supplier}</h2>
          <Badge tone="neutral">Quote v{a.quoteVersion}</Badge><Badge tone="attention">Manual quote</Badge>
        </div>
        <p className="-mt-3 text-xs text-text-muted">Supplier name and quote details are the supplier's own statements.</p>

        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-text-muted">Item</dt><dd>{a.item.category.replaceAll("_", " ")}, {DISPLAY_QUANTITY(a.item.quantityScaled, a.item.unit)}</dd></div>
          <div><dt className="text-xs text-text-muted">Goods</dt><dd className="tnum">{a.goods}</dd></div>
          {a.charges.map((c) => <div key={c.label}><dt className="text-xs text-text-muted">{c.label}{c.mandatory ? " (required)" : ""}</dt><dd className="tnum">{c.amount}</dd></div>)}
          <div className="sm:col-span-2 border-t border-border pt-3"><dt className="text-xs text-text-muted">Exact total you are approving</dt><dd className="tnum text-[28px] font-semibold">{a.total}</dd></div>
          <div><dt className="text-xs text-text-muted">Promised delivery</dt><dd>{a.deliveryPromisedBy ? fmtDate(a.deliveryPromisedBy) : "Not stated"}{a.deliveryTz ? ` (${a.deliveryTz})` : ""}</dd></div>
          <div><dt className="text-xs text-text-muted">Payment terms</dt><dd>{a.paymentTerms}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Delivery address</dt><dd>{a.deliveryTo}</dd></div>
          <div><dt className="text-xs text-text-muted">Quote valid until</dt><dd>{fmtDate(a.quoteValidUntil)}</dd></div>
          <div><dt className="text-xs text-text-muted">This approval expires</dt><dd>{fmtDate(a.expiresAt)}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Identity evidence</dt><dd>{a.verification}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Source</dt><dd>{a.quoteSource}</dd></div>
        </dl>

        <p className="rounded-control bg-primary-soft p-3 text-sm text-primary">{a.consequence}</p>

        <div className="flex flex-wrap gap-3">
          <Button disabled={!usable} pending={confirm.isPending} onClick={() => { setRejection(null); setOpen(true); }}>{a.buttonLabel}</Button>
          <Link className={buttonClasses("secondary")} to={back}>Back to comparison</Link>
        </div>
        {!usable && <p className="-mt-2 text-xs text-text-muted">The approve button is off because this approval can no longer be used.</p>}
      </Card>

      <ConfirmDialog open={open} title={a.buttonLabel + "?"} confirmLabel={a.buttonLabel} pending={confirm.isPending} onConfirm={() => confirm.mutate()} onCancel={() => setOpen(false)}
        body={<><p>You're approving <strong>{a.supplier}</strong>'s quote v{a.quoteVersion} for <strong className="tnum">{a.total}</strong>.</p><p className="mt-2">The supplier still has to accept. Acceptance does not prove delivery. You confirm receipt yourself.</p></>} />
    </div>
  );
}
