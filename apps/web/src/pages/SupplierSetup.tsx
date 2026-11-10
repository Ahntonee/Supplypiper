import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError } from "../api";
import { Alert, Badge, Button, buttonClasses, Card, Checkbox, EmptyState, Field, Input, PageTitle, Select, Skeleton } from "../components/ui";
import type { ShellContext } from "../components/Shell";
import { isMoney, isQty, mayDo } from "../format";
import { DISPLAY_QUANTITY } from "../labels";
import { fmtDate } from "../session";

interface Profile { category: string; areaCode: string; claimedLegalName: string | null; shareContact: boolean; updatedAt: string }
export function useProfile(orgId: string | undefined) {
  return useQuery({
    queryKey: ["profile", orgId], enabled: !!orgId, retry: false,
    queryFn: async () => { try { return await api<Profile>("GET", `/orgs/${orgId}/supplier-profile`); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; } },
  });
}

const NOT_SUPPLIER = <Alert tone="attention" title="Supplying is not enabled for this organisation">Switch to a supplying organisation to use this page.</Alert>;

/* ---------------- profile and identity ---------------- */
const profileSchema = z.object({
  category: z.string().min(1), areaCode: z.string().trim().min(1, "Enter the area you deliver to").max(60),
  claimedLegalName: z.string().trim().max(160).optional(), shareContact: z.boolean(),
});

export function SupplierProfile() {
  const { org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const q = useProfile(org?.id);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const canEdit = mayDo(org, "catalogue.manage");
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema), mode: "onTouched", values: q.data ? { category: q.data.category, areaCode: q.data.areaCode, claimedLegalName: q.data.claimedLegalName ?? "", shareContact: q.data.shareContact } : { category: "palm_oil", areaCode: "", claimedLegalName: "", shareContact: false },
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof profileSchema>) => api("PUT", `/orgs/${org!.id}/supplier-profile`, { ...v, claimedLegalName: v.claimedLegalName || undefined }),
    onSuccess: async () => { setErr(null); setSaved(true); await qc.invalidateQueries({ queryKey: ["profile", org?.id] }); },
    onError: (e) => { setSaved(false); setErr(e as ApiError); },
  });
  if (org && !org.capabilities.includes("supplier")) return NOT_SUPPLIER;
  if (!org || q.isLoading) return <Skeleton className="h-64 w-full max-w-2xl" />;

  return (
    <div className="grid max-w-3xl gap-6">
      <PageTitle title="Supplier profile" sub="Buyers see these details when choosing who to ask. They are your own claims; SupplyPiper does not verify them." />
      {!q.data && <Alert tone="attention" title="You aren't listed yet">Buyers can only invite suppliers who have a profile. Save yours to appear in the supplier directory.</Alert>}
      {saved && <Alert tone="success" title="Profile saved" />}
      {err && <Alert tone="danger" title="Could not save">{err.message}</Alert>}
      <Card>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setSaved(false); save.mutate(v); })}>
          <Field label="What you supply">{(a) => <Select {...a} disabled={!canEdit} {...register("category")}><option value="palm_oil">Palm oil</option></Select>}</Field>
          <Field label="Area you deliver to" hint="Buyers filter and judge distance by this. Use the same name buyers use for their delivery area." error={errors.areaCode?.message}>{(a) => <Input {...a} disabled={!canEdit} {...register("areaCode")} />}</Field>
          <Field label="Registered business name (optional)" hint="Shown to buyers as claimed by you, not checked.">{(a) => <Input {...a} disabled={!canEdit} {...register("claimedLegalName")} />}</Field>
          <Checkbox label="Share contact details with buyers who choose you" hint="Contact sharing isn't switched on yet; this records your preference." disabled={!canEdit} {...register("shareContact")} />
          {canEdit ? <div><Button type="submit" pending={save.isPending}>Save profile</Button></div> : <p className="text-sm text-text-muted">Your role can view the profile but not change it.</p>}
        </form>
      </Card>

      <Card className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-semibold">Identity and authority</h2><Badge tone="attention">Not available yet</Badge></div>
        <p className="text-sm text-text-muted">Agent verification isn't switched on, so quotes are submitted by people at your business and buyers see them labelled that way. When it arrives, setup will be four separate steps:</p>
        <ol className="list-decimal pl-5 text-sm text-text-muted">
          <li>Register an agent on Concordium's public registry with your wallet. You prove control by signing.</li>
          <li>Record who owns that agent.</li>
          <li>Your organisation separately authorises the agent to quote for it.</li>
          <li>SupplyPiper checks the registry again just before each order is committed.</li>
        </ol>
        <p className="text-sm text-text-muted">Verification would show who is accountable for an agent. It would not show product quality, business registration, ability to deliver, solvency, or any endorsement by Concordium.</p>
      </Card>
      <Card className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-semibold">Quote agent controls</h2><Badge tone="attention">Not available yet</Badge></div>
        <p className="text-sm text-text-muted">Rules for an agent that prepares quotes (allowed products, margins, validity limits, human review of outgoing quotes) will appear here with agent setup. Until then, every quote is written and submitted by your team.</p>
      </Card>
    </div>
  );
}

/* ---------------- catalogue and stock ---------------- */
interface Product { id: string; name: string; category: string; unit: string; priceBasis: string; unitPriceMinor: string; currency: string; stock: { availableScaled: string; reservedScaled: string; statedAt: string } | null }
export function useProducts(orgId: string | undefined, enabled = true) {
  return useQuery({ queryKey: ["products", orgId], enabled: !!orgId && enabled, queryFn: async () => (await api<{ products: Product[] }>("GET", `/orgs/${orgId}/products`)).products });
}

const productSchema = z.object({
  name: z.string().trim().min(1, "Name the product").max(120), category: z.string().min(1), unit: z.enum(["L", "mL", "kg", "g", "each"]),
  priceBasis: z.string().trim().min(1, "Say what the price covers").max(120), unitPrice: z.string().refine(isMoney, "Use an amount like 2500 or 2500.50"),
});

export function Catalogue() {
  const { org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const profile = useProfile(org?.id);
  const products = useProducts(org?.id, !!org?.capabilities.includes("supplier"));
  const canManage = mayDo(org, "catalogue.manage");
  const [err, setErr] = useState<ApiError | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof productSchema>>({
    resolver: zodResolver(productSchema), mode: "onTouched", defaultValues: { category: "palm_oil", unit: "L", priceBasis: "per unit, before delivery and tax" },
  });
  const add = useMutation({
    mutationFn: (v: z.infer<typeof productSchema>) => api("POST", `/orgs/${org!.id}/products`, v),
    onSuccess: async () => { setErr(null); setOkMsg("Product added. Record a stock statement so it can back a quote."); reset(); await qc.invalidateQueries({ queryKey: ["products", org?.id] }); },
    onError: (e) => { setOkMsg(null); setErr(e as ApiError); },
  });
  if (org && !org.capabilities.includes("supplier")) return NOT_SUPPLIER;
  if (!org || profile.isLoading || products.isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <>
      <PageTitle title="Catalogue and stock" sub="What you sell and how much you say you have. Stock figures are your own statements; they only become a reservation when you accept an order." />
      {!profile.data && <div className="mb-4"><Alert tone="attention" title="Create your supplier profile first" action={<Link className={buttonClasses("secondary")} to="/app/profile">Open profile</Link>}>Products can only be added once your profile exists.</Alert></div>}
      {products.isError && <div className="mb-4"><Alert tone="danger" title="Could not load products" action={<Button variant="secondary" onClick={() => products.refetch()}>Retry</Button>}>{(products.error as ApiError).message}</Alert></div>}
      {okMsg && <div className="mb-4"><Alert tone="success" title={okMsg} /></div>}
      {err && <div className="mb-4"><Alert tone="danger" title={err.code === "PROFILE_REQUIRED" ? "Create your supplier profile first" : "Could not add the product"}>{err.message}</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 content-start gap-3">
          {products.data?.length === 0 && <EmptyState title="No products yet">Add the first product on the right. Buyers never see your catalogue prices; they only see the quotes you submit to them.</EmptyState>}
          {products.data?.map((p) => <ProductCard key={p.id} p={p} orgId={org.id} canManage={canManage} />)}
        </div>
        {canManage ? (
          <Card className="content-start">
            <h2 className="text-lg font-semibold">Add a product</h2>
            <form className="mt-3 grid gap-4" noValidate onSubmit={handleSubmit((v) => { setOkMsg(null); add.mutate(v); })}>
              <Field label="Name" error={errors.name?.message}>{(a) => <Input {...a} {...register("name")} />}</Field>
              <Field label="Category">{(a) => <Select {...a} {...register("category")}><option value="palm_oil">Palm oil</option></Select>}</Field>
              <Field label="Sold by the" hint="Litres and kilograms are never converted into each other.">{(a) => <Select {...a} {...register("unit")}><option>L</option><option>mL</option><option>kg</option><option>g</option><option>each</option></Select>}</Field>
              <Field label="Your usual price per unit (NGN)" error={errors.unitPrice?.message}>{(a) => <Input {...a} inputMode="decimal" {...register("unitPrice")} />}</Field>
              <Field label="What the price covers" error={errors.priceBasis?.message}>{(a) => <Input {...a} {...register("priceBasis")} />}</Field>
              <Button type="submit" pending={add.isPending} disabled={!profile.data}>Add product</Button>
            </form>
          </Card>
        ) : <Alert tone="info" title="View only">Your role can see the catalogue but not change it.</Alert>}
      </div>
    </>
  );
}

function ProductCard({ p, orgId, canManage }: { p: Product; orgId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [val, setVal] = useState(""); const [touched, setTouched] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const stock = useMutation({
    mutationFn: () => api("POST", `/orgs/${orgId}/products/${p.id}/inventory`, { available: val.trim() }),
    onSuccess: async () => { setErr(null); setVal(""); setTouched(false); await qc.invalidateQueries({ queryKey: ["products", orgId] }); },
    onError: (e) => setErr(e as ApiError),
  });
  const bad = !isQty(val) || Number(val) <= 0;
  return (
    <Card className="!p-4">
      <h2 className="break-words text-base font-semibold">{p.name}</h2>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-text-muted">Usual price</dt><dd className="tnum">NGN {(BigInt(p.unitPriceMinor) / 100n).toString()}.{(BigInt(p.unitPriceMinor) % 100n).toString().padStart(2, "0")} per {p.unit}</dd></div>
        <div><dt className="text-xs text-text-muted">Price basis</dt><dd>{p.priceBasis}</dd></div>
        <div><dt className="text-xs text-text-muted">Declared available</dt><dd className="tnum">{p.stock ? DISPLAY_QUANTITY(p.stock.availableScaled, p.unit) : "No statement yet"}</dd></div>
        <div><dt className="text-xs text-text-muted">Reserved for accepted orders</dt><dd className="tnum">{p.stock ? DISPLAY_QUANTITY(p.stock.reservedScaled, p.unit) : "None"}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-text-muted">Last stated</dt><dd>{p.stock ? `${fmtDate(p.stock.statedAt)}. Declared by you; not a guarantee.` : "Never"}</dd></div>
      </dl>
      {canManage && (
        <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad) stock.mutate(); }}>
          <Field label={`New total available now (${p.unit})`} hint="Replaces your last statement. Stock already reserved stays reserved." error={touched && bad ? "Enter a quantity above zero, like 100" : err?.message}>
            {(a) => <Input {...a} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} />}
          </Field>
          <Button type="submit" variant="secondary" pending={stock.isPending}>Record stock statement</Button>
        </form>
      )}
    </Card>
  );
}
