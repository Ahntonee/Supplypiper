import { useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Alert, AuditTimeline, Badge, Button, buttonClasses, Card, Checkbox, ConfirmDialog, EmptyState, Field, Input, Money, PageTitle, Skeleton } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { DISPLAY_QUANTITY, EVENT_TEXT, REQUEST_STATE } from "../labels";
import { fmtDate, userTimezone } from "../session";

interface RequestDetailData {
  request: { id: string; category: string; quantityScaled: string; unit: string; budgetMinor: string; currency: string; state: string; deliverByUtc: string; deliverTz: string; destinationArea: string; destinationAddress: string; responseDeadline: string | null; allowManualLane: boolean };
  recipients: Array<{ supplierOrgId: string; name: string; status: string }>;
  quotesReceived: number; timeline: Array<{ event: string; createdAt: string }>;
  order: { id: string; state: string } | null;
}

export function useRequest(orgId: string | undefined, id: string | undefined) {
  return useQuery({ queryKey: ["request", orgId, id], enabled: !!orgId && !!id, queryFn: () => api<RequestDetailData>("GET", `/orgs/${orgId}/requests/${id}`) });
}

export function RequestDetail() {
  const { org } = useOutletContext<ShellContext>();
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useRequest(org?.id, id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["request", org?.id, id] }), qc.invalidateQueries({ queryKey: ["requests", org?.id] })]);
  const act = useMutation({
    mutationFn: (path: string) => api("POST", `/orgs/${org!.id}/requests/${id}/${path}`, {}),
    onSuccess: async () => { setActionError(null); setConfirmCancel(false); await refresh(); },
    onError: (e) => { setActionError(e as ApiError); setConfirmCancel(false); },
  });

  if (q.isLoading || (!q.data && !q.isError)) return <Skeleton className="h-64 w-full" />;
  if (q.isError) {
    const notFound = (q.error as ApiError).status === 404;
    return <Alert tone={notFound ? "attention" : "danger"} title={notFound ? "Request not found" : "Could not load this request"} action={notFound ? undefined : <Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{notFound ? "It may belong to another organisation." : (q.error as ApiError).message}</Alert>;
  }
  const { request: r, recipients, quotesReceived, timeline, order } = q.data!;
  const st = REQUEST_STATE[r.state] ?? { label: r.state, tone: "neutral" as const };
  const canCompare = ["collecting", "ready_for_comparison"].includes(r.state);
  const cancellable = ["draft", "published", "collecting", "ready_for_comparison"].includes(r.state);

  return (
    <>
      <PageTitle title={`${r.category.replaceAll("_", " ")}: ${DISPLAY_QUANTITY(r.quantityScaled, r.unit)}`} sub="Request details, who was asked, and what has happened so far."
        actions={<Badge tone={st.tone}>{st.label}</Badge>} />
      {actionError && <div className="mb-4"><Alert tone="danger" title="That didn't work">{actionError.message}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-6">
          <Card>
            <h2 className="text-lg font-semibold">What you asked for</h2>
            <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-text-muted">Quantity</dt><dd className="tnum">{DISPLAY_QUANTITY(r.quantityScaled, r.unit)}</dd></div>
              <div><dt className="text-xs text-text-muted">Maximum landed cost</dt><dd><Money minor={r.budgetMinor} currency={r.currency} /></dd></div>
              <div><dt className="text-xs text-text-muted">Deliver by</dt><dd>{fmtDate(r.deliverByUtc)} <span className="text-text-muted">({r.deliverTz})</span></dd></div>
              <div><dt className="text-xs text-text-muted">Quote deadline</dt><dd>{r.responseDeadline ? fmtDate(r.responseDeadline) : "Set when you publish"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Delivery address</dt><dd>{r.destinationAddress}, {r.destinationArea}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Quotes entered by a person at the supplier</dt><dd>{r.allowManualLane ? "Allowed (kept in a separate lane, no agent verification)" : "Not allowed"}</dd></div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold">Suppliers asked</h2>
            {recipients.length === 0 ? <p className="mt-2 text-sm text-text-muted">No one has been asked yet. Nothing is shared until you publish.</p> : (
              <ul className="mt-3 divide-y divide-border">
                {recipients.map((x) => (
                  <li key={x.supplierOrgId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="min-w-0 break-words font-medium">{x.name}</span>
                    <Badge tone={x.status === "responded" ? "success" : "neutral"}>{x.status === "responded" ? "Quote received" : "Waiting for a reply"}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card className="grid gap-3">
            <h2 className="text-lg font-semibold">Next step</h2>
            {r.state === "draft" && <><p className="text-sm text-text-muted">Choose which suppliers receive this request. You'll see exactly what they'll see before anything is shared.</p><Link className={buttonClasses("primary")} to={`/app/requests/${r.id}/publish`}>Choose suppliers and publish</Link></>}
            {(canCompare || r.state === "published") && <>
              <p className="text-sm text-text-muted">{quotesReceived === 0 ? "No quotes have arrived yet. Pending replies stay pending; nothing is generated in their place." : `${quotesReceived} quote${quotesReceived === 1 ? "" : "s"} received.`}</p>
              {quotesReceived > 0 && canCompare
                ? <Link className={buttonClasses("primary")} to={`/app/requests/${r.id}/compare`}>Compare quotes</Link>
                : <Button disabled aria-describedby="no-quotes">Compare quotes</Button>}
              {quotesReceived === 0 && <p id="no-quotes" className="text-xs text-text-muted">Available once at least one quote arrives.</p>}
              {r.state === "collecting" && <Button variant="secondary" pending={act.isPending} onClick={() => act.mutate("ready-for-comparison")}>Stop waiting and mark ready</Button>}
            </>}
            {order && <><p className="text-sm text-text-muted">An order exists for this request.</p><Link className={buttonClasses("primary")} to={`/app/orders/${order.id}`}>View the order</Link></>}
            {["closed", "cancelled", "expired"].includes(r.state) && !order && <p className="text-sm text-text-muted">This request is finished.</p>}
            {cancellable && <Button variant="ghost" onClick={() => setConfirmCancel(true)}>Cancel this request</Button>}
          </Card>

          <Card>
            <h2 className="mb-3 text-lg font-semibold">Activity</h2>
            <AuditTimeline events={timeline.map((e) => ({ at: fmtDate(e.createdAt), text: EVENT_TEXT[e.event] ?? e.event.replaceAll(".", " ") }))} />
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirmCancel} danger title="Cancel this request?" confirmLabel="Cancel request" pending={act.isPending}
        body="Suppliers will no longer be able to quote. Quotes already received are kept in the activity history." onConfirm={() => act.mutate("cancel")} onCancel={() => setConfirmCancel(false)} />
      <p className="mt-6 text-xs text-text-muted"><Link className="underline" to="/app/requests">Back to all requests</Link></p>
    </>
  );
}

/* ---------------- publish ---------------- */
interface SupplierRow { orgId: string; name: string; claimedLegalName: string | null; category: string; areaCode: string; lastInventoryUpdate: string | null; completedOrders: number | string; agentEvidence: string }

const defaultDeadline = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function Publish() {
  const { org } = useOutletContext<ShellContext>();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const req = useRequest(org?.id, id);
  const suppliers = useQuery({ queryKey: ["suppliers", req.data?.request.category], enabled: !!req.data, queryFn: () => api<{ suppliers: SupplierRow[] }>("GET", `/suppliers?category=${encodeURIComponent(req.data!.request.category)}`) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [share, setShare] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [touched, setTouched] = useState(false);

  const publish = useMutation({
    mutationFn: () => api("POST", `/orgs/${org!.id}/requests/${id}/publish`, { supplierOrgIds: [...picked], responseDeadline: new Date(deadline).toISOString(), confirmShare: share }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["request", org?.id, id] }); await qc.invalidateQueries({ queryKey: ["requests", org?.id] }); nav(`/app/requests/${id}`); },
    onError: (e) => setError(e as ApiError),
  });

  if (req.isLoading || (!req.data && !req.isError)) return <Skeleton className="h-64 w-full" />;
  if (req.isError) return <Alert tone="danger" title="Could not load this request" action={<Button variant="secondary" onClick={() => req.refetch()}>Retry</Button>}>{(req.error as ApiError).message}</Alert>;
  const r = req.data!.request;
  if (r.state !== "draft") return <Alert tone="attention" title="This request is already published"><Link className="underline" to={`/app/requests/${r.id}`}>Go to the request</Link></Alert>;

  const toggle = (sid: string) => setPicked((p) => { const n = new Set(p); if (n.has(sid)) n.delete(sid); else n.add(sid); return n; });
  const problems = [!picked.size && "Choose at least one supplier", !share && "Confirm the sharing statement below"].filter(Boolean) as string[];
  const deadlineBad = new Date(deadline).getTime() <= Date.now() || new Date(deadline).getTime() > new Date(r.deliverByUtc).getTime();

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div>
        <PageTitle title="Choose suppliers" sub="Only the suppliers you tick receive this request. You can't add more later, so ask everyone you want quotes from now." />
        {error && <div className="mb-4"><Alert tone="danger" title="Not published">{error.message}</Alert></div>}
        {suppliers.isLoading && <Skeleton className="h-40 w-full" />}
        {suppliers.isError && <Alert tone="danger" title="Could not load suppliers" action={<Button variant="secondary" onClick={() => suppliers.refetch()}>Retry</Button>}>{(suppliers.error as ApiError).message}</Alert>}
        {suppliers.data?.suppliers.length === 0 && <EmptyState title="No suppliers are listed for this item yet">Suppliers appear here once they've created a profile. Nothing has been shared.</EmptyState>}
        <fieldset className="grid gap-3">
          <legend className="sr-only">Suppliers to invite</legend>
          {suppliers.data?.suppliers.filter((s) => s.orgId !== org?.id).map((s) => (
            <Card key={s.orgId} className="!p-4">
              <Checkbox label={s.name} checked={picked.has(s.orgId)} onChange={() => toggle(s.orgId)}
                hint={`Area: ${s.areaCode} · Last stock update: ${s.lastInventoryUpdate ? fmtDate(s.lastInventoryUpdate) : "never"} · Completed orders: ${s.completedOrders} · Agent evidence: ${s.agentEvidence}`} />
              <p className="ml-8 text-xs text-text-muted">Business details are claimed by the supplier and not verified by SupplyPiper.</p>
            </Card>
          ))}
        </fieldset>
      </div>

      <aside className="grid content-start gap-4">
        <Card className="grid gap-3">
          <h2 className="text-lg font-semibold">What suppliers will see</h2>
          <dl className="grid gap-2 text-sm">
            <div><dt className="text-xs text-text-muted">Item and quantity</dt><dd>{r.category.replaceAll("_", " ")}, {DISPLAY_QUANTITY(r.quantityScaled, r.unit)}</dd></div>
            <div><dt className="text-xs text-text-muted">Deliver by</dt><dd>{fmtDate(r.deliverByUtc)} ({r.deliverTz})</dd></div>
            <div><dt className="text-xs text-text-muted">Delivery address</dt><dd>{r.destinationAddress}, {r.destinationArea}</dd></div>
            <div><dt className="text-xs text-text-muted">Your organisation's name</dt><dd>{org?.name}</dd></div>
          </dl>
          <p className="rounded-control bg-primary-soft p-2 text-sm text-primary"><strong>Not shared:</strong> your maximum budget, and other suppliers' quotes.</p>
        </Card>
        <Card className="grid gap-3">
          <Field label="Suppliers must reply by" hint={`Your timezone: ${userTimezone()}. Must be before your delivery deadline.`} error={touched && deadlineBad ? "Choose a time in the future and before the delivery deadline" : undefined}>
            {(a) => <Input {...a} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />}
          </Field>
          <Checkbox label="I understand this shares the details above with the selected suppliers" checked={share} onChange={(e) => setShare(e.target.checked)} />
          {touched && problems.length > 0 && <p role="alert" className="text-sm text-danger-text">{problems.join(". ")}.</p>}
          <Button pending={publish.isPending} onClick={() => { setTouched(true); setError(null); if (problems.length === 0 && !deadlineBad) publish.mutate(); }}>
            Publish to {picked.size || "selected"} supplier{picked.size === 1 ? "" : "s"}
          </Button>
          <Link className={buttonClasses("secondary")} to={`/app/requests/${r.id}`}>Not now</Link>
        </Card>
      </aside>
    </div>
  );
}

/* ---------------- suppliers directory ---------------- */
export function Suppliers() {
  const q = useQuery({ queryKey: ["suppliers", "all"], queryFn: () => api<{ suppliers: SupplierRow[] }>("GET", "/suppliers") });
  return (
    <>
      <PageTitle title="Suppliers" sub="Real supplier profiles in this environment. Business details are the supplier's own claims. No ratings are shown because no completed-order history exists to base one on." />
      {q.isLoading && <Skeleton className="h-40 w-full" />}
      {q.isError && <Alert tone="danger" title="Could not load suppliers" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}
      {q.data?.suppliers.length === 0 && <EmptyState title="No suppliers yet">Suppliers appear here once they've set up a profile.</EmptyState>}
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data?.suppliers.map((s) => (
          <li key={s.orgId}>
            <Card className="h-full !p-4">
              <h2 className="break-words text-base font-semibold">{s.name}</h2>
              <dl className="mt-2 grid gap-1 text-sm">
                <div className="flex gap-2"><dt className="text-text-muted">Category</dt><dd>{s.category.replaceAll("_", " ")}</dd></div>
                <div className="flex gap-2"><dt className="text-text-muted">Area</dt><dd>{s.areaCode}</dd></div>
                <div className="flex gap-2"><dt className="text-text-muted">Last stock update</dt><dd>{s.lastInventoryUpdate ? fmtDate(s.lastInventoryUpdate) : "Never"}</dd></div>
                <div className="flex gap-2"><dt className="text-text-muted">Completed orders</dt><dd>{s.completedOrders}</dd></div>
                <div className="flex gap-2"><dt className="text-text-muted">Agent evidence</dt><dd>{s.agentEvidence}</dd></div>
              </dl>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
