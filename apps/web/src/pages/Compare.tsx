import { useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, EmptyState, PageTitle, Skeleton, TableScroll } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { fmtDate } from "../session";

interface Offer {
  rank: number; quoteVersionId: string; version: number; supplierName: string; source: string; goodsTotal: string; landedTotal: string; landedTotalMinor: string;
  charges: Array<{ kind: string; label: string; amount: string; mandatory: boolean }>; deliveryPromisedBy: string | null; paymentTerms: string;
  lastUpdatedAt: string; completedOrders: number | string; verification: string; whyThisMatches: string[];
}
interface Comparison {
  id: string; calculationVersion: string; sortedBy: "landed_cost" | "earliest_delivery"; noEligibleOffers: boolean; generatedBy: string; nextSteps?: string;
  lanes: { verified_agent: Offer[]; manual: Offer[] };
  excluded: Array<{ quoteVersionId: string; supplierName: string; reasons: Array<{ code: string; text: string }> }>;
}

const deliveryCharge = (o: Offer) => o.charges.find((c) => c.kind === "delivery")?.amount ?? "Not stated";
const otherCharges = (o: Offer) => { const x = o.charges.filter((c) => c.kind !== "delivery"); return x.length ? x.map((c) => `${c.label}: ${c.amount}`).join("; ") : "None stated"; };
const promised = (o: Offer) => (o.deliveryPromisedBy ? fmtDate(o.deliveryPromisedBy) : "Not stated");

export function Compare() {
  const { org } = useOutletContext<ShellContext>();
  const { id } = useParams();
  const nav = useNavigate();
  const [sort, setSort] = useState<"landed_cost" | "earliest_delivery">("landed_cost");
  const [error, setError] = useState<ApiError | null>(null);
  const q = useQuery({
    queryKey: ["comparison", org?.id, id, sort], enabled: !!org && !!id, staleTime: 0, gcTime: 0,
    queryFn: () => api<Comparison>("POST", `/orgs/${org!.id}/requests/${id}/comparisons`, { sortedBy: sort }),
  });
  const review = useMutation({
    mutationFn: (quoteVersionId: string) => api<{ intentId: string }>("POST", `/orgs/${org!.id}/requests/${id}/approval-intents`, { quoteVersionId, sortedBy: sort }),
    onSuccess: (r) => nav(`/app/approvals/${r.intentId}`),
    onError: (e) => setError(e as ApiError),
  });

  const lanes = q.data?.lanes;
  const manual = lanes?.manual ?? [];
  const agent = lanes?.verified_agent ?? [];
  const firstId = [...agent, ...manual][0]?.quoteVersionId;

  const action = (o: Offer) => (
    <Button variant={o.quoteVersionId === firstId ? "primary" : "secondary"} pending={review.isPending && review.variables === o.quoteVersionId} disabled={review.isPending} onClick={() => { setError(null); review.mutate(o.quoteVersionId); }}>
      Review and approve<span className="sr-only"> {o.supplierName}</span>
    </Button>
  );

  return (
    <>
      <PageTitle title="Compare quotes" sub="Landed total = goods + delivery + tax + mandatory fees. A quote with an unknown required charge is excluded, never guessed."
        actions={<Link className={buttonClasses("secondary")} to={`/app/requests/${id}`}>Back to request</Link>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Sort offers" className="inline-flex overflow-hidden rounded-control border border-control-border">
          {([["landed_cost", "Lowest landed cost"], ["earliest_delivery", "Earliest delivery"]] as const).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={sort === v} onClick={() => setSort(v)}
              className={`min-h-11 px-4 text-sm font-medium ${sort === v ? "bg-primary text-white" : "bg-surface text-text hover:bg-primary-soft"}`}>{label}</button>
          ))}
        </div>
        {q.data && <p className="text-xs text-text-muted">Calculated by SupplyPiper's fixed rules (version {q.data.calculationVersion}). This is not an AI summary. "Best match" means best under the criteria shown, not best supplier overall.</p>}
      </div>

      {error && <div className="mb-4"><Alert tone="danger" title={error.code === "NOT_ELIGIBLE" ? "That quote can't be approved" : "Could not prepare the approval"}>{error.message}{Object.values(error.details).map((t) => <span key={t} className="block">{t}</span>)}</Alert></div>}
      {q.isLoading && <div className="grid gap-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>}
      {q.isError && <Alert tone={(q.error as ApiError).status === 409 ? "attention" : "danger"} title="Quotes can't be compared right now" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}

      {q.data && (
        <div className="grid min-w-0 gap-8">
          {q.data.noEligibleOffers && (
            <Alert tone="attention" title="No quote qualifies">
              {q.data.nextSteps} See why each quote was excluded below. Nothing has been approved or spent.
            </Alert>
          )}

          <section aria-labelledby="lane-agent" className="grid gap-2">
            <h2 id="lane-agent" className="text-xl font-semibold">Verified-agent quotes</h2>
            <EmptyState title="None yet">Agent verification isn't live in this environment, so no quote can sit in this lane. It never borrows results from the manual lane.</EmptyState>
          </section>

          <section aria-labelledby="lane-manual" className="grid min-w-0 gap-3">
            <h2 id="lane-manual" className="text-xl font-semibold">Quotes entered by a person at the supplier</h2>
            <p className="text-sm text-text-muted">Supplier statements. No agent verification applies to these and none is implied.</p>
            {manual.length === 0 && <EmptyState title="No eligible quotes in this lane">Quotes that don't qualify are listed below with the reason.</EmptyState>}

            {/* Narrow screens: one labelled card per supplier */}
            <div className="grid gap-3 sm:hidden">
              {manual.map((o) => (
                <article key={o.quoteVersionId} aria-label={`Quote from ${o.supplierName}`} className="rounded-card border border-border bg-surface p-4">
                  <header className="flex flex-wrap items-center gap-2"><Badge tone="success">Rank {o.rank}</Badge><h3 className="min-w-0 break-words font-semibold">{o.supplierName}</h3></header>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs text-text-muted">Landed total</dt><dd className="tnum text-lg font-semibold">{o.landedTotal}</dd></div>
                    <div><dt className="text-xs text-text-muted">Goods</dt><dd className="tnum">{o.goodsTotal}</dd></div>
                    <div><dt className="text-xs text-text-muted">Delivery</dt><dd className="tnum">{deliveryCharge(o)}</dd></div>
                    <div><dt className="text-xs text-text-muted">Tax and fees</dt><dd className="tnum">{otherCharges(o)}</dd></div>
                    <div><dt className="text-xs text-text-muted">Promised delivery</dt><dd>{promised(o)}</dd></div>
                    <div><dt className="text-xs text-text-muted">Payment terms</dt><dd>{o.paymentTerms}</dd></div>
                    <div><dt className="text-xs text-text-muted">Quote version</dt><dd>v{o.version}, updated {fmtDate(o.lastUpdatedAt)}</dd></div>
                    <div><dt className="text-xs text-text-muted">Completed orders</dt><dd>{String(o.completedOrders)}</dd></div>
                  </dl>
                  <Why o={o} />
                  <div className="mt-3">{action(o)}</div>
                </article>
              ))}
            </div>

            {/* Wider screens: full comparison table, scrollable and keyboard-reachable with fixed column labels */}
            {manual.length > 0 && (
              <div className="hidden min-w-0 sm:block">
                <TableScroll label="Quote comparison table">
                  <table className="w-full min-w-[1100px] text-left text-sm">
                    <caption className="sr-only">Eligible quotes ranked within the manual lane</caption>
                    <thead className="border-b border-border bg-canvas text-xs text-text-muted"><tr>
                      {["Rank", "Supplier", "Goods", "Delivery", "Tax and fees", "Landed total", "Promised delivery", "Payment terms", "Quote", "Completed orders", "Decision"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {manual.map((o) => (
                        <tr key={o.quoteVersionId} className="border-b border-border align-top last:border-0">
                          <td className="px-4 py-3"><Badge tone="success">{o.rank}</Badge></td>
                          <th scope="row" className="max-w-[14rem] break-words px-4 py-3 font-medium">{o.supplierName}<span className="block text-xs font-normal text-text-muted">{o.source}</span></th>
                          <td className="tnum whitespace-nowrap px-4 py-3">{o.goodsTotal}</td>
                          <td className="tnum whitespace-nowrap px-4 py-3">{deliveryCharge(o)}</td>
                          <td className="tnum px-4 py-3">{otherCharges(o)}</td>
                          <td className="tnum whitespace-nowrap px-4 py-3 font-semibold">{o.landedTotal}</td>
                          <td className="px-4 py-3">{promised(o)}</td>
                          <td className="px-4 py-3">{o.paymentTerms}</td>
                          <td className="px-4 py-3">v{o.version}<span className="block text-xs text-text-muted">updated {fmtDate(o.lastUpdatedAt)}</span></td>
                          <td className="px-4 py-3">{String(o.completedOrders)}</td>
                          <td className="px-4 py-3">{action(o)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
                <div className="mt-3 grid gap-2">{manual.map((o) => <div key={o.quoteVersionId} className="text-sm"><span className="font-medium">{o.supplierName}: </span><Why o={o} inline /></div>)}</div>
              </div>
            )}
          </section>

          {q.data.excluded.length > 0 && (
            <section aria-labelledby="excluded" className="grid gap-3">
              <h2 id="excluded" className="text-xl font-semibold">Excluded quotes</h2>
              <ul className="grid gap-3">
                {q.data.excluded.map((e) => (
                  <li key={e.quoteVersionId}><Card className="!p-4">
                    <h3 className="break-words font-semibold">{e.supplierName}</h3>
                    <ul className="mt-2 list-disc pl-5 text-sm text-danger-text">{e.reasons.map((r) => <li key={r.code}>{r.text}</li>)}</ul>
                  </Card></li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function Why({ o, inline }: { o: Offer; inline?: boolean }) {
  return (
    <details className={inline ? "inline" : "mt-3 text-sm"}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-primary underline">Why this matches</summary>
      <ul className="ml-5 mt-1 list-disc text-text-muted">{o.whyThisMatches.map((w) => <li key={w}>{w}</li>)}<li>{o.verification}</li></ul>
    </details>
  );
}
