import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Alert, AuditTimeline, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, EvidencePanel, Field, Input, Money, Quantity,
  QuoteRow, Select, Skeleton, StepProgress, Textarea, Wordmark,
} from "../components/ui";

const tokens: Array<[string, string, string]> = [
  ["canvas", "#F6F8F7", "page background"], ["surface", "#FFFFFF", "cards"], ["text", "#142321", "body text"], ["text-muted", "#52625E", "secondary text"],
  ["border", "#DCE4E0", "dividers (decorative)"], ["control-border", "#7C8B86", "form field edges, 3:1"], ["primary", "#145B50", "actions"], ["primary-hover", "#10483F", "hover"], ["primary-soft", "#E9F3EF", "soft fill"],
  ["attention-bg", "#FFF4D6", "attention fill"], ["attention-text", "#754C00", "attention text"], ["danger-bg", "#FDEDEC", "danger fill"], ["danger-text", "#A52727", "danger text"], ["focus", "#246BCE", "focus ring"],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-labelledby={title.replaceAll(" ", "-")} className="grid gap-3"><h2 id={title.replaceAll(" ", "-")} className="text-xl font-semibold">{title}</h2>{children}</section>;
}

export default function Catalogue() {
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <div className="mx-auto grid max-w-[1120px] gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><Wordmark /><h1 className="mt-4 text-[28px] font-semibold sm:text-[32px]">Component catalogue</h1><p className="max-w-prose text-text-muted">Every sample below is labelled sample content for design review. It is not live data.</p></div>
        <Link className="text-sm font-medium text-primary underline" to="/">Back to site</Link>
      </header>

      <Section title="Colour tokens">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {tokens.map(([n, hex, use]) => (
            <li key={n} className="rounded-control border border-border bg-surface p-3 text-sm"><span aria-hidden="true" className="mb-2 block h-10 rounded border border-border" style={{ background: hex }} /><p className="font-medium">{n}</p><p className="tnum text-xs text-text-muted">{hex} · {use}</p></li>
          ))}
        </ul>
      </Section>

      <Section title="Typography">
        <Card className="grid gap-2"><p className="text-[32px] font-semibold">Page title 32</p><p className="text-[28px] font-semibold">Page title 28</p><p>Body 15: Palm oil, 40 L, deliver by Friday 17:00.</p><p className="text-sm text-text-muted">Label 14 muted</p><p className="tnum text-sm">Tabular figures: 1,111.11 · 8,888.88</p></Card>
      </Section>

      <Section title="Buttons">
        <Card className="flex flex-wrap gap-3">
          <Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="danger">Danger</Button><Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button><Button pending={pending} onClick={() => { setPending(true); setTimeout(() => setPending(false), 1500); }}>{pending ? "Working" : "Click for pending"}</Button>
        </Card>
      </Section>

      <Section title="Form controls">
        <Card className="grid gap-4 sm:grid-cols-2">
          <Field label="Default" hint="Helper text">{(a) => <Input {...a} defaultValue="Palm oil" />}</Field>
          <Field label="Error" error="Enter an amount like 120000.00">{(a) => <Input {...a} defaultValue="12k" />}</Field>
          <Field label="Disabled">{(a) => <Input {...a} disabled defaultValue="Locked" />}</Field>
          <Field label="Select">{(a) => <Select {...a}><option>L</option><option>kg</option></Select>}</Field>
          <div className="sm:col-span-2"><Field label="Notes">{(a) => <Textarea {...a} />}</Field></div>
          <Checkbox label="Checkbox with explanation" hint="Describes the consequence of ticking" />
        </Card>
      </Section>

      <Section title="Badges and alerts">
        <Card className="grid gap-3">
          <div className="flex flex-wrap gap-2"><Badge>Neutral</Badge><Badge tone="success">Success</Badge><Badge tone="attention">Stale</Badge><Badge tone="danger">Failed</Badge><Badge tone="info">Pending</Badge><Badge tone="attention">Testnet</Badge><Badge tone="attention">Demo</Badge></div>
          <Alert tone="info" title="Information">Neutral guidance.</Alert>
          <Alert tone="success" title="Saved">Your draft is saved.</Alert>
          <Alert tone="attention" title="Verification unavailable">Drafting still works; verified orders are paused until the check succeeds.</Alert>
          <Alert tone="danger" title="Something failed" action={<Button variant="secondary">Retry</Button>}>Your input is kept.</Alert>
        </Card>
      </Section>

      <Section title="Money and quantity">
        <Card className="grid gap-1"><Money minor="10500000" currency="NGN" emphasis /><Money minor="123456789012345" currency="NGN" /><Quantity value="40" unit="L" /></Card>
      </Section>

      <Section title="Quote rows (sample content)">
        <div className="grid gap-3">
          <QuoteRow rank={1} supplier="Sample Supplier Ltd" source="Submitted by a person (supplier statement)" goods={<Money minor="10000000" currency="NGN" />} delivery={<Money minor="500000" currency="NGN" />} tax={<Money minor="0" currency="NGN" />} landed={<Money minor="10500000" currency="NGN" emphasis />} promised="Fri 13 Nov, 12:00" updated="9 Nov, 09:30" completed="No completed orders recorded" />
          <QuoteRow stale supplier="A supplier with a very long registered trading name that must wrap cleanly without clipping Enterprises International" source="Supplier agent (statement)" goods={<Money minor="9800000" currency="NGN" />} delivery="Unknown" tax="Not stated" landed="Incomplete" promised="Not stated" updated="1 Nov" completed="No completed orders recorded" excludedReason="A delivery or tax charge is missing, so the landed total cannot be calculated." />
        </div>
      </Section>

      <Section title="Evidence panel (sample content)">
        <EvidencePanel identity="stale" authority="not_bound" network="testnet" simulated checkedAt="Never (sample)" lastSuccessAt="Never (sample)" established={["Sample only: nothing was checked"]} notEstablished={["Product quality", "Business registration", "Ability to fulfil orders", "Solvency", "Endorsement by Concordium"]} />
      </Section>

      <Section title="Empty state, skeleton and progress">
        <EmptyState title="No requests yet" action={<Button>Create a request</Button>}>Your drafts and published requests will be listed here.</EmptyState>
        <Card className="grid gap-2" ><Skeleton className="h-5 w-1/3" /><Skeleton className="h-16 w-full" /></Card>
        <Card><StepProgress steps={["Request", "Quotes", "Compare", "Approve", "Receive"]} current={2} /></Card>
      </Section>

      <Section title="Confirmation dialog and audit timeline">
        <Card className="grid gap-4">
          <div><Button variant="secondary" onClick={() => setDialog(true)}>Open confirmation dialog</Button></div>
          <AuditTimeline events={[{ at: "9 Nov 09:12", text: "Request drafted", actor: "Sample user" }, { at: "9 Nov 09:20", text: "Published to 2 suppliers", actor: "Sample user" }, { at: "9 Nov 11:02", text: "Quote v1 submitted", actor: "Sample supplier" }]} />
        </Card>
        <ConfirmDialog open={dialog} title="Approve order for NGN 105,000.00?" body="This approves one exact quote version and total. The supplier must still accept it. Acceptance is not proof of delivery." confirmLabel="Approve order for NGN 105,000.00" onConfirm={() => setDialog(false)} onCancel={() => setDialog(false)} />
      </Section>
    </div>
  );
}
