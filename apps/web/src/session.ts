import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, setCsrf, type EnvInfo, type Me, type OrgSummary } from "./api";

export function useEnv() {
  return useQuery({ queryKey: ["env"], queryFn: () => api<EnvInfo>("GET", "/environment"), staleTime: 5 * 60_000, retry: 1 });
}

export function useMe() {
  return useQuery({
    queryKey: ["me"], retry: false, staleTime: 60_000,
    queryFn: async () => {
      try { const m = await api<Me>("GET", "/auth/me"); setCsrf(m.csrfToken); return m; }
      catch (e) { if (e instanceof ApiError && e.status === 401) { setCsrf(""); return null; } throw e; }
    },
  });
}

export function useOrgs(enabled: boolean) {
  return useQuery({ queryKey: ["orgs"], enabled, queryFn: async () => (await api<{ organisations: OrgSummary[] }>("GET", "/orgs")).organisations });
}

const KEY = "sp.activeOrg";
/** Remembering the selected organisation is a per-viewer convenience only; the server re-checks membership on every call. */
export function useActiveOrg(orgs: OrgSummary[] | undefined): [OrgSummary | undefined, (id: string) => void] {
  const [id, setId] = useState<string | null>(() => { try { return localStorage.getItem(KEY); } catch { return null; } });
  const active = orgs?.find((o) => o.id === id) ?? orgs?.[0];
  useEffect(() => { if (active && active.id !== id) setId(active.id); }, [active, id]);
  return [active, (next) => { setId(next); try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ } }];
}

export const fmtDate = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
export const userTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
