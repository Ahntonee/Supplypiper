import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from "react";
import { formatMinor, money } from "@supplypiper/domain";

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(" ");

/* ---------- Brand ---------- */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M8 21 14 11l5 7 5-9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="21" r="2.6" fill="#fff" /><circle cx="14" cy="11" r="2.6" fill="#fff" />
      <circle cx="19" cy="18" r="2.6" fill="#fff" /><circle cx="24" cy="9" r="2.6" fill="var(--attention-bg)" />
    </svg>
  );
}
export const Wordmark = () => (
  <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-text"><Mark /><span>SupplyPiper</span></span>
);

/* ---------- Buttons ---------- */
type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover border-transparent",
  secondary: "bg-surface text-text border-border hover:bg-primary-soft",
  danger: "bg-danger-text text-white hover:bg-[#8a1f1f] border-transparent",
  ghost: "bg-transparent text-primary border-transparent hover:bg-primary-soft",
};
export const buttonClasses = (variant: Variant = "primary", extra?: string) =>
  cx("inline-flex min-h-11 items-center justify-center gap-2 rounded-control border px-4 text-sm font-medium transition-colors", variants[variant], extra);
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; pending?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", pending, disabled, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref} {...rest} disabled={disabled || pending} aria-busy={pending || undefined}
      className={cx("inline-flex min-h-11 items-center justify-center gap-2 rounded-control border px-4 text-sm font-medium transition-colors", "disabled:cursor-not-allowed disabled:opacity-55", variants[variant], className)}
    >
      {pending && <Spinner />}{children}
    </button>
  );
});
export const Spinner = () => (
  <svg className="size-4 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
);

/* ---------- Form controls ---------- */
interface FieldProps { label: string; error?: string; hint?: string; children: (a: { id: string; "aria-invalid": boolean | undefined; "aria-describedby": string | undefined }) => ReactNode }
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? msgId : undefined })}
      {(error || hint) && (
        <p id={msgId} className={cx("text-xs", error ? "text-danger-text" : "text-text-muted")}>{error ? <><span className="sr-only">Error: </span>{error}</> : hint}</p>
      )}
    </div>
  );
}
const control = "min-h-11 w-full rounded-control border border-control-border bg-surface px-3 text-sm text-text placeholder:text-text-muted/80 disabled:bg-canvas disabled:text-text-muted aria-[invalid=true]:border-danger-text aria-[invalid=true]:bg-danger-bg/40";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) { return <input ref={ref} {...p} className={cx(control, className)} />; });
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) { return <select ref={ref} {...p} className={cx(control, className)} />; });
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) { return <textarea ref={ref} {...p} className={cx(control, "min-h-24 py-2", className)} />; });
export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }>(function Checkbox({ label, hint, ...p }, ref) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start gap-3 py-2">
      <input id={id} ref={ref} type="checkbox" {...p} aria-describedby={hint ? `${id}-h` : undefined} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
      <label htmlFor={id} className="text-sm"><span className="font-medium">{label}</span>{hint && <span id={`${id}-h`} className="block text-xs text-text-muted">{hint}</span>}</label>
    </div>
  );
});

/* ---------- Badges, alerts ---------- */
type Tone = "neutral" | "success" | "attention" | "danger" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-canvas text-text-muted border-border",
  success: "bg-primary-soft text-primary border-primary/20",
  attention: "bg-attention-bg text-attention-text border-attention-text/20",
  danger: "bg-danger-bg text-danger-text border-danger-text/20",
  info: "bg-[#E8F0FC] text-[#174A99] border-[#174A99]/20",
};
export const Badge = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => (
  <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>
);
export function Alert({ tone = "info", title, children, action }: { tone?: Exclude<Tone, "neutral">; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex flex-wrap items-start gap-3 rounded-control border p-3 text-sm", tones[tone])}>
      <div className="min-w-0 flex-1">{title && <p className="font-semibold">{title}</p>}{children && <div>{children}</div>}</div>
      {action}
    </div>
  );
}

/* ---------- Layout bits ---------- */
export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <section className={cx("rounded-card border border-border bg-surface p-4 shadow-card sm:p-6", className)}>{children}</section>
);
export const PageTitle = ({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-[28px] font-semibold sm:text-[32px]">{title}</h1>{sub && <p className="mt-1 max-w-prose text-text-muted">{sub}</p>}</div>
    {actions}
  </div>
);
export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden="true" className={cx("skeleton", className)} />;
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2 rounded-card border border-dashed border-border bg-surface p-6">
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="max-w-prose text-sm text-text-muted">{children}</p>}
      {action}
    </div>
  );
}

/* ---------- Money and quantity (never floats) ---------- */
export function Money({ minor, currency, emphasis }: { minor: string | bigint; currency: string; emphasis?: boolean }) {
  return <span className={cx("tnum whitespace-nowrap", emphasis && "text-lg font-semibold")}>{formatMinor(money(BigInt(minor), currency))}</span>;
}
export const Quantity = ({ value, unit }: { value: string; unit: string }) => <span className="tnum whitespace-nowrap">{value} {unit}</span>;

/* ---------- Native dialog (focus trap, Escape and inert page come from showModal) ---------- */
export function Dialog({ open, onClose, title, children, variant = "modal", labelledBy }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; variant?: "modal" | "drawer"; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref} className={variant} aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {title && <h2 id={titleId} className="px-6 pt-6 text-lg font-semibold">{title}</h2>}
      {children}
    </dialog>
  );
}
export function ConfirmDialog({ open, title, body, confirmLabel, pending, danger, onConfirm, onCancel }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; pending?: boolean; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <div className="px-6 py-3 text-sm text-text-muted">{body}</div>
      <div className="flex flex-wrap justify-end gap-3 px-6 pb-6">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} pending={pending} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}

/* ---------- Step progress ---------- */
export function StepProgress({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined} className={cx("flex items-center gap-2 text-sm", i === current ? "font-semibold text-text" : "text-text-muted")}>
          <span className={cx("grid size-6 place-items-center rounded-full border text-xs", i < current ? "border-primary bg-primary text-white" : i === current ? "border-primary text-primary" : "border-border")}>{i < current ? <span aria-hidden="true">✓</span> : i + 1}</span>
          <span>{s}<span className="sr-only">{i < current ? " (done)" : i === current ? " (current)" : ""}</span></span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Evidence panel: identity, authority and network are separate records ---------- */
export type EvidenceState = "verified" | "unverified" | "pending" | "stale" | "unavailable" | "revoked" | "invalid";
const stateTone: Record<EvidenceState, Tone> = { verified: "success", unverified: "neutral", pending: "info", stale: "attention", unavailable: "attention", revoked: "danger", invalid: "danger" };
export interface EvidenceProps {
  identity: EvidenceState; authority: "bound" | "not_bound"; network: "testnet" | "mainnet" | "demo"; checkedAt?: string;
  badgeId?: string; evidenceUrl?: string; simulated?: boolean; established: string[]; notEstablished: string[];
}
export function EvidencePanel(p: EvidenceProps) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-base font-semibold">Agent evidence</h3>
        <Badge tone={p.network === "mainnet" ? "neutral" : "attention"}>{p.network === "demo" ? "Demo (simulated)" : p.network === "testnet" ? "Testnet" : "Mainnet"}</Badge>
        {p.simulated && <Badge tone="attention">Simulated result</Badge>}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="text-xs text-text-muted">Agent identity</dt><dd><Badge tone={stateTone[p.identity]}>{p.identity}</Badge></dd></div>
        <div><dt className="text-xs text-text-muted">Authority to quote for this organisation</dt><dd><Badge tone={p.authority === "bound" ? "success" : "attention"}>{p.authority === "bound" ? "authorised by organisation" : "not authorised"}</Badge></dd></div>
        <div><dt className="text-xs text-text-muted">Last successful check</dt><dd className="tnum text-sm">{p.checkedAt ?? "Never"}</dd></div>
        <div><dt className="text-xs text-text-muted">Badge identifier</dt><dd className="break-all text-sm">{p.badgeId ? (p.evidenceUrl ? <a className="text-primary underline" href={p.evidenceUrl} rel="noreferrer">{p.badgeId}</a> : p.badgeId) : "None recorded"}</dd></div>
      </dl>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div><p className="font-medium">What was checked</p><ul className="mt-1 list-disc pl-5 text-text-muted">{p.established.map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><p className="font-medium">What remains unproven</p><ul className="mt-1 list-disc pl-5 text-text-muted">{p.notEstablished.map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
    </Card>
  );
}

/* ---------- Quote row ---------- */
export interface QuoteRowProps { supplier: string; source: string; goods: ReactNode; delivery: ReactNode; tax: ReactNode; landed: ReactNode; promised: string; updated: string; completed: string; stale?: boolean; excludedReason?: string; rank?: number }
export function QuoteRow(q: QuoteRowProps) {
  return (
    <article className={cx("rounded-card border bg-surface p-4", q.excludedReason ? "border-danger-text/30" : "border-border")} aria-label={`Quote from ${q.supplier}`}>
      <header className="flex flex-wrap items-center gap-2">
        {q.rank && <Badge tone="success">Rank {q.rank}</Badge>}
        <h3 className="min-w-0 break-words font-semibold">{q.supplier}</h3>
        <span className="ml-auto text-xs text-text-muted">{q.source}</span>
        {q.stale && <Badge tone="attention">Stale</Badge>}
      </header>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-text-muted">Goods</dt><dd>{q.goods}</dd></div>
        <div><dt className="text-xs text-text-muted">Delivery</dt><dd>{q.delivery}</dd></div>
        <div><dt className="text-xs text-text-muted">Tax and fees</dt><dd>{q.tax}</dd></div>
        <div><dt className="text-xs text-text-muted">Landed total</dt><dd className="font-semibold">{q.landed}</dd></div>
        <div><dt className="text-xs text-text-muted">Promised delivery</dt><dd>{q.promised}</dd></div>
        <div><dt className="text-xs text-text-muted">Quote updated</dt><dd>{q.updated}</dd></div>
        <div><dt className="text-xs text-text-muted">Completed orders</dt><dd>{q.completed}</dd></div>
      </dl>
      {q.excludedReason && <p className="mt-3 rounded-control bg-danger-bg p-2 text-sm text-danger-text">Excluded: {q.excludedReason}</p>}
    </article>
  );
}

/* ---------- Audit timeline ---------- */
export function AuditTimeline({ events }: { events: Array<{ at: string; text: string; actor?: string }> }) {
  return (
    <ol className="grid gap-0 border-l border-border pl-4">
      {events.map((e, i) => (
        <li key={i} className="relative pb-4 last:pb-0">
          <span aria-hidden="true" className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-primary bg-surface" />
          <p className="text-sm font-medium">{e.text}</p>
          <p className="tnum text-xs text-text-muted"><time>{e.at}</time>{e.actor && ` · ${e.actor}`}</p>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Scrolling table wrapper with keyboard access ---------- */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return <div role="region" aria-label={label} tabIndex={0} className="relative overflow-x-auto rounded-card border border-border bg-surface">{children}</div>; // relative: contains visually-hidden (absolutely positioned) text so it cannot widen the page
}
