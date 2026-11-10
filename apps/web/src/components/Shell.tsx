import { useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, setCsrf, type OrgSummary } from "../api";
import { useActiveOrg, useEnv, useMe, useOrgs } from "../session";
import { Alert, Badge, Button, Dialog, Select, Skeleton, Wordmark } from "./ui";

interface NavItem { to: string; label: string; end?: boolean }

function navFor(org: OrgSummary | undefined): NavItem[] {
  const items: NavItem[] = [{ to: "/app", label: "Overview", end: true }];
  if (org?.capabilities.includes("buyer")) items.push({ to: "/app/requests", label: "Requests" }, { to: "/app/orders", label: "Orders" }, { to: "/app/suppliers", label: "Suppliers" });
  return items;
}

function NavList({ items, onNavigate, showCatalogue }: { items: NavItem[]; onNavigate?: () => void; showCatalogue: boolean }) {
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center rounded-control px-3 text-sm font-medium ${isActive ? "bg-primary-soft text-primary" : "text-text hover:bg-canvas"}`;
  return (
    <nav aria-label="Main" className="grid gap-1">
      {items.map((i) => <NavLink key={i.to} to={i.to} end={i.end} className={link} onClick={onNavigate}>{i.label}</NavLink>)}
      {showCatalogue && <NavLink to="/design" className={link} onClick={onNavigate}>Component catalogue</NavLink>}
    </nav>
  );
}

export function Shell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const me = useMe();
  const env = useEnv();
  const orgsQ = useOrgs(!!me.data);
  const [org, setOrg] = useActiveOrg(orgsQ.data);
  const [drawer, setDrawer] = useState(false);

  if (me.isLoading) return <div className="p-8"><Skeleton className="h-8 w-48" /></div>;
  if (me.isError) return <div className="p-8"><Alert tone="danger" title="Could not load your session" action={<Button variant="secondary" onClick={() => me.refetch()}>Retry</Button>}>The server is unreachable. Nothing you entered was lost.</Alert></div>;
  if (!me.data) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;

  const signOut = async () => {
    try { await api("POST", "/auth/logout"); } catch { /* session may already be gone */ }
    setCsrf(""); qc.clear(); nav("/login", { replace: true });
  };
  const items = navFor(org);
  const showCatalogue = env.data?.mode !== "production";

  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className="sticky top-0 hidden h-svh flex-col gap-6 border-r border-border bg-surface p-4 lg:flex">
        <Link to="/app" className="px-2 py-1"><Wordmark /></Link>
        <NavList items={items} showCatalogue={showCatalogue} />
      </aside>

      <div className="flex min-w-0 flex-col">
        {env.data?.banner && <div role="status" className="border-b border-attention-text/20 bg-attention-bg px-4 py-2 text-sm font-medium text-attention-text sm:px-8">{env.data.banner}</div>}
        <header className="flex h-16 items-center gap-3 border-b border-border bg-surface px-4 sm:h-[72px] sm:px-8">
          <Button variant="secondary" className="lg:hidden" aria-label="Open menu" aria-expanded={drawer} aria-controls="mobile-nav" onClick={() => setDrawer(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </Button>
          <div className="min-w-0 flex-1">
            {orgsQ.data && orgsQ.data.length > 0 && (
              <div className="flex max-w-md items-center gap-2">
                <label htmlFor="org" className="sr-only">Organisation</label>
                <Select id="org" value={org?.id} onChange={(e) => setOrg(e.target.value)}>
                  {orgsQ.data.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
                <span className="hidden gap-1 sm:flex">{org?.capabilities.map((c) => <Badge key={c} tone="success">{c}</Badge>)}</span>
              </div>
            )}
          </div>
          <span className="hidden text-sm text-text-muted md:inline">{me.data.user.displayName}</span>
          <Button variant="secondary" onClick={signOut}>Sign out</Button>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:p-8">
          <Outlet context={{ org, orgs: orgsQ.data, orgsLoading: orgsQ.isLoading }} />
        </main>
      </div>

      <Dialog open={drawer} onClose={() => setDrawer(false)} variant="drawer" labelledBy="mobile-nav-title">
        <div id="mobile-nav" className="flex h-full flex-col gap-6 p-4">
          <div className="flex items-center justify-between"><span id="mobile-nav-title"><Wordmark /></span><Button variant="secondary" aria-label="Close menu" onClick={() => setDrawer(false)}>✕</Button></div>
          <NavList items={items} showCatalogue={showCatalogue} onNavigate={() => setDrawer(false)} />
        </div>
      </Dialog>
    </div>
  );
}

export interface ShellContext { org: OrgSummary | undefined; orgs: OrgSummary[] | undefined; orgsLoading: boolean }
