import { useState } from "react";
import { Link, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, Checkbox, EmptyState, Field, Input, Money, PageTitle, Select, Skeleton, TableScroll } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { fmtDate, userTimezone } from "../session";

/* ---------------- onboarding: create organisation ---------------- */
const orgSchema = z.object({
  name: z.string().trim().min(2, "Enter your organisation's name").max(120),
  buyer: z.boolean(), supplier: z.boolean(), areaCode: z.string().trim().max(60).optional(),
}).refine((v) => v.buyer || v.supplier, { path: ["buyer"], message: "Choose at least one: buying, supplying, or both" });

function CreateOrg() {
  const qc = useQueryClient();
  const [formError, setFormError] = useState<ApiError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof orgSchema>>({ resolver: zodResolver(orgSchema), mode: "onTouched", defaultValues: { buyer: true, supplier: false } });
  const create = useMutation({
    mutationFn: (v: z.infer<typeof orgSchema>) => api("POST", "/orgs", { name: v.name, areaCode: v.areaCode || undefined, capabilities: [v.buyer && "buyer", v.supplier && "supplier"].filter(Boolean) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
    onError: (e) => setFormError(e as ApiError),
  });
  return (
    <div className="max-w-xl">
      <PageTitle title="Set up your organisation" sub="You'll be the owner. Buying and supplying are separate capabilities; switching between them never grants extra permissions." />
      <Card>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setFormError(null); create.mutate(v); })}>
          {formError && <Alert tone="danger" title="Could not create the organisation">{formError.message}</Alert>}
          <Field label="Organisation name" error={errors.name?.message}>{(a) => <Input {...a} autoComplete="organization" {...register("name")} />}</Field>
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">What will you do here?</legend>
            <Checkbox label="Buy supplies" hint="Request quotes and approve orders" {...register("buyer")} />
            <Checkbox label="Supply goods" hint="Maintain a catalogue and respond to requests" {...register("supplier")} />
            {errors.buyer && <p role="alert" className="text-xs text-danger-text">{errors.buyer.message}</p>}
          </fieldset>
          <Field label="Delivery area (optional)" hint="The pilot runs in one configured area per organisation.">{(a) => <Input {...a} {...register("areaCode")} />}</Field>
          <Button type="submit" pending={create.isPending}>Create organisation</Button>
        </form>
      </Card>
    </div>
  );
}

/* ---------------- overview ---------------- */
interface RequestRow { id: string; category: string; quantityScaled: string; unit: string; budgetMinor: string; currency: string; state: string; deliverByUtc: string; createdAt: string }
interface OrderRow { id: string; state: string; side: "buyer" | "supplier" }
interface InboxRow { id: string; myQuoteState: string }

function Stat({ label, value, loading, hint }: { label: string; value: number | undefined; loading: boolean; hint: string }) {
  return (
    <Card className="!p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <div className="mt-1 h-9 text-[32px] font-semibold leading-9 tnum">{loading ? <Skeleton className="h-9 w-12" /> : value ?? "–"}</div>
      <p className="mt-1 text-xs text-text-muted">{hint}</p>
    </Card>
  );
}
const live = (s: string) => !["completed", "declined", "cancelled"].includes(s);

export function Overview() {
  const ctx = useOutletContext<ShellContext>();
  const org = ctx.org;
  const isBuyer = !!org?.capabilities.includes("buyer");
  const isSupplier = !!org?.capabilities.includes("supplier");
  const requests = useQuery({ queryKey: ["requests", org?.id], enabled: !!org && isBuyer, queryFn: () => api<{ requests: RequestRow[] }>("GET", `/orgs/${org!.id}/requests`) });
  const orders = useQuery({ queryKey: ["orders", org?.id], enabled: !!org, queryFn: () => api<{ orders: OrderRow[] }>("GET", `/orgs/${org!.id}/orders`) });
  const inbox = useQuery({ queryKey: ["inbox", org?.id], enabled: !!org && isSupplier, queryFn: () => api<{ requests: InboxRow[] }>("GET", `/orgs/${org!.id}/inbox`) });

  if (ctx.orgsLoading) return <Skeleton className="h-40 w-full max-w-xl" />;
  if (!org) return <CreateOrg />;

  const failed = [requests, orders, inbox].find((q) => q.isError);
  const o = orders.data?.orders ?? [];
  const r = requests.data?.requests ?? [];
  const ib = inbox.data?.requests ?? [];

  return (
    <>
      <PageTitle title="Overview" sub={`${org.name} · you are ${org.roles.join(", ").replaceAll("_", " ")}`} />
      {failed && <div className="mb-4"><Alert tone="danger" title="Some numbers could not load" action={<Button variant="secondary" onClick={() => { requests.refetch(); orders.refetch(); inbox.refetch(); }}>Retry</Button>}>These counts come straight from the server; none are estimated.</Alert></div>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {isBuyer && <Stat label="Awaiting replies" value={r.filter((x) => ["published", "collecting"].includes(x.state)).length} loading={requests.isLoading} hint="Published requests collecting quotes" />}
        {isBuyer && <Stat label="Ready to compare" value={r.filter((x) => x.state === "ready_for_comparison").length} loading={requests.isLoading} hint="Quotes you can review" />}
        {isSupplier && <Stat label="Open invitations" value={ib.filter((x) => x.myQuoteState === "no quote yet").length} loading={inbox.isLoading} hint="Requests you haven't quoted" />}
        {isSupplier && <Stat label="Orders to accept" value={o.filter((x) => x.side === "supplier" && x.state === "awaiting_supplier_acceptance").length} loading={orders.isLoading} hint="Waiting for your response" />}
        <Stat label="Active orders" value={o.filter((x) => live(x.state)).length} loading={orders.isLoading} hint="Not yet completed" />
      </div>

      <div className="mt-8">
        {isBuyer && !requests.isLoading && r.length === 0 && (
          <EmptyState title="Make your first request" action={<Link className={buttonClasses("primary")} to="/app/requests/new">Create a request</Link>}>
            Describe what you need and your maximum landed cost. You can save a draft now; nothing is shared with suppliers until you publish.
          </EmptyState>
        )}
        {isSupplier && !isBuyer && !inbox.isLoading && ib.length === 0 && (
          <EmptyState title="No invitations yet">When a buyer invites your organisation to quote, the request will appear here.</EmptyState>
        )}
        {isBuyer && r.length > 0 && <RequestsTable rows={r.slice(0, 5)} title="Latest requests" />}
      </div>
    </>
  );
}

const stateTone = (s: string) => (s === "draft" ? "neutral" : s === "cancelled" || s === "expired" ? "danger" : "success") as "neutral" | "danger" | "success";

function RequestsTable({ rows, title }: { rows: RequestRow[]; title: string }) {
  return (
    <TableScroll label={title}>
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">{title}</caption>
        <thead className="border-b border-border bg-canvas text-xs text-text-muted"><tr>
          <th scope="col" className="px-4 py-3 font-medium">Item</th><th scope="col" className="px-4 py-3 font-medium">Quantity</th>
          <th scope="col" className="px-4 py-3 font-medium">Deliver by</th><th scope="col" className="px-4 py-3 font-medium">Budget</th><th scope="col" className="px-4 py-3 font-medium">Status</th>
        </tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.id} className="border-b border-border last:border-0">
            <td className="px-4 py-3 font-medium">{x.category.replaceAll("_", " ")}</td>
            <td className="tnum px-4 py-3">{(BigInt(x.quantityScaled) / 1_000_000n).toString()} {x.unit}</td>
            <td className="px-4 py-3">{fmtDate(x.deliverByUtc)}</td>
            <td className="px-4 py-3"><Money minor={x.budgetMinor} currency={x.currency} /></td>
            <td className="px-4 py-3"><Badge tone={stateTone(x.state)}>{x.state.replaceAll("_", " ")}</Badge></td>
          </tr>))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/* ---------------- requests ---------------- */
export function Requests() {
  const { org } = useOutletContext<ShellContext>();
  const saved = (useLocation().state as { saved?: boolean } | null)?.saved;
  const q = useQuery({ queryKey: ["requests", org?.id], enabled: !!org, queryFn: () => api<{ requests: RequestRow[] }>("GET", `/orgs/${org!.id}/requests`) });
  if (org && !org.capabilities.includes("buyer")) return <Alert tone="attention" title="Buying is not enabled for this organisation">Switch to a buying organisation to see requests.</Alert>;
  return (
    <>
      <PageTitle title="Requests" sub="Everything you've asked suppliers to quote." actions={<Link className={buttonClasses("primary")} to="/app/requests/new">New request</Link>} />
      {saved && <div className="mb-4"><Alert tone="success" title="Draft saved">It is private to your organisation. Publishing to suppliers isn't available in this interface yet.</Alert></div>}
      {q.isLoading && <Skeleton className="h-40 w-full" />}
      {q.isError && <Alert tone="danger" title="Could not load requests" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as ApiError).message}</Alert>}
      {q.data && q.data.requests.length === 0 && <EmptyState title="No requests yet" action={<Link className={buttonClasses("primary")} to="/app/requests/new">Create a request</Link>}>Your drafts and published requests will be listed here.</EmptyState>}
      {q.data && q.data.requests.length > 0 && <RequestsTable rows={q.data.requests} title="All requests" />}
    </>
  );
}

const requestSchema = z.object({
  category: z.string().min(1), quantity: z.string().regex(/^\d+(\.\d{1,6})?$/, "Use a number like 40 or 2.5").refine((v) => Number(v) > 0, "Must be more than zero"),
  unit: z.enum(["L", "mL", "kg", "g", "each"]),
  budget: z.string().regex(/^\d+(\.\d{1,2})?$/, "Use an amount like 120000 or 120000.50"),
  deliverBy: z.string().min(1, "Choose a delivery deadline").refine((v) => new Date(v).getTime() > Date.now(), "Deadline must be in the future"),
  destinationArea: z.string().trim().min(1, "Enter the delivery area").max(80),
  destinationAddress: z.string().trim().min(1, "Enter the delivery address").max(300),
  allowManualLane: z.boolean(),
});
type RequestForm = z.infer<typeof requestSchema>;

export function NewRequest() {
  const { org } = useOutletContext<ShellContext>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const tz = userTimezone();
  const [formError, setFormError] = useState<ApiError | null>(null);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<RequestForm>({
    resolver: zodResolver(requestSchema), mode: "onTouched", defaultValues: { category: "palm_oil", unit: "L", allowManualLane: false },
  });
  const save = useMutation({
    mutationFn: (v: RequestForm) => api("POST", `/orgs/${org!.id}/requests`, { ...v, currency: "NGN", deliverBy: new Date(v.deliverBy).toISOString(), deliverTz: tz }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["requests", org?.id] }); nav("/app/requests", { state: { saved: true } }); },
    onError: (e) => {
      const err = e as ApiError; setFormError(err);
      for (const [k, m] of Object.entries(err.details)) if (k in requestSchema.shape) setError(k as keyof RequestForm, { message: m });
    },
  });
  if (!org || !org.capabilities.includes("buyer")) return <Alert tone="attention" title="Buying is not enabled for this organisation">Switch to a buying organisation to create requests.</Alert>;
  return (
    <div className="max-w-2xl">
      <PageTitle title="New request" sub="Save a draft first. Nothing is shared with suppliers until you publish." />
      <Card>
        <form className="grid gap-5" noValidate onSubmit={handleSubmit((v) => { setFormError(null); save.mutate(v); })}>
          {formError && <Alert tone="danger" title={formError.status === 0 ? "You're offline" : "Please fix the highlighted fields"}>{formError.message}</Alert>}
          <Field label="Item">{(a) => <Select {...a} {...register("category")}><option value="palm_oil">Palm oil</option></Select>}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quantity" error={errors.quantity?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("quantity")} />}</Field>
            <Field label="Unit" hint="Litres and kilograms are never converted into each other.">{(a) => <Select {...a} {...register("unit")}><option>L</option><option>mL</option><option>kg</option><option>g</option><option>each</option></Select>}</Field>
          </div>
          <Field label="Maximum landed cost (NGN)" hint="Goods, delivery, tax and mandatory charges together. Suppliers never see this." error={errors.budget?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("budget")} />}</Field>
          <Field label="Deliver by" hint={`Your timezone: ${tz}. Suppliers see this as a fixed moment, not just a day.`} error={errors.deliverBy?.message}>{(a) => <Input {...a} type="datetime-local" {...register("deliverBy")} />}</Field>
          <Field label="Delivery area" error={errors.destinationArea?.message}>{(a) => <Input {...a} {...register("destinationArea")} />}</Field>
          <Field label="Delivery address" hint="Shared only with suppliers you choose to invite, after you publish." error={errors.destinationAddress?.message}>{(a) => <Input {...a} autoComplete="street-address" {...register("destinationAddress")} />}</Field>
          <Checkbox label="Allow quotes entered by a person at the supplier" hint="These carry no agent verification and are kept in a separate lane." {...register("allowManualLane")} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" pending={save.isPending}>Save draft</Button>
            <Link className={buttonClasses("secondary")} to="/app/requests">Cancel</Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
