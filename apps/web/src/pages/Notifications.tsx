import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Alert, Badge, Button, EmptyState, Skeleton } from "../components/ui";
import { fmtDate } from "../session";

export interface Notice { id: string; orgId: string | null; kind: string; title: string; body: string; link: string; read: boolean; createdAt: string }
interface NoticeList { unread: number; notifications: Notice[] }

export const noticesKey = ["notifications"] as const;

/** Polled lightly so a new request or order shows without a reload. No push channel exists yet, and this does not pretend otherwise. */
export function useUnread(enabled: boolean) {
  return useQuery({ queryKey: [...noticesKey, "count"], enabled, refetchInterval: 30_000, queryFn: () => api<{ unread: number }>("GET", "/notifications/unread-count").then((r) => r.unread) });
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: noticesKey, queryFn: () => api<NoticeList>("GET", "/notifications") });
  const refresh = () => qc.invalidateQueries({ queryKey: noticesKey });
  const readAll = useMutation({ mutationFn: () => api("POST", "/notifications/read-all", {}), onSuccess: refresh });
  const open = async (n: Notice) => {
    try { if (!n.read) await api("POST", `/notifications/${n.id}/read`, {}); } catch { /* opening still works; it stays unread */ }
    // A notification can belong to another of the person's organisations: switch first, then do a full navigation so every query reloads for that organisation.
    if (n.orgId) {
      let current: string | null = null;
      try { current = localStorage.getItem("sp.activeOrg"); } catch { /* ignore */ }
      if (current !== n.orgId) {
        try { localStorage.setItem("sp.activeOrg", n.orgId); } catch { /* ignore */ }
        window.location.assign(n.link);
        return;
      }
    }
    await refresh();
    nav(n.link);
  };
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-[28px] font-semibold">Notifications</h1><p className="mt-1 text-sm text-text-muted">Short notices about your requests and orders. Details are shown after you open them.</p></div>
        <Button variant="secondary" disabled={!q.data?.unread} pending={readAll.isPending} onClick={() => readAll.mutate()}>Mark all as read</Button>
      </div>
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.isError && <Alert tone="danger" title="Could not load notifications" action={<Button variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>Nothing was lost.</Alert>}
      {q.data && q.data.notifications.length === 0 && <EmptyState title="Nothing yet">When a buyer asks you to quote, approves a quote, or a supplier accepts an order, a notice appears here.</EmptyState>}
      <ul className="grid gap-3">
        {q.data?.notifications.map((n) => (
          <li key={n.id} className={`rounded-card border p-4 ${n.read ? "border-border bg-surface" : "border-primary/40 bg-primary-soft"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{n.title}</p>
              {!n.read && <Badge tone="success">Unread</Badge>}
              <span className="ml-auto text-xs text-text-muted">{fmtDate(n.createdAt)}</span>
            </div>
            <p className="mt-1 text-sm text-text-muted">{n.body}</p>
            <button type="button" aria-label={`Open: ${n.title}`} className="mt-2 min-h-11 text-sm font-medium text-primary underline" onClick={() => open(n)}>Open</button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-muted">Email copies go only where email delivery is switched on. <Link className="underline" to="/app">Back to overview</Link></p>
    </div>
  );
}
