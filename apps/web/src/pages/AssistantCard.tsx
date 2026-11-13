import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type OrgSummary } from "../api";
import { Alert, Badge, Button, Card, Field, Textarea } from "../components/ui";
import { toLocalInput } from "../format";
import { useEnv, userTimezone } from "../session";

export interface Proposal { category: string; quantity: string; unit: string; budget: string; deliverBy: string; deliverTz: string; destinationArea: string; destinationAddress: string }
type IntakeResult =
  | { runId: string; state: "awaiting_publish_approval"; proposal: Proposal; assumptions: string[]; notice: string }
  | { runId: string; state: "needs_clarification"; questions: string[] }
  | { runId: string; state: "failed" | "cancelled"; failure: { reason: string; assistantAvailable: boolean; message: string } };

export const proposalToForm = (p: Proposal) => ({
  category: p.category, quantity: p.quantity, unit: p.unit as "L" | "mL" | "kg" | "g" | "each", budget: p.budget, deliverBy: toLocalInput(p.deliverBy),
  destinationArea: p.destinationArea, destinationAddress: p.destinationAddress,
});

/** Optional AI help to fill the request form. It proposes; the person reviews every field and saves. Nothing is saved or sent. */
export function AssistantCard({ org, onProposal }: { org: OrgSummary; onProposal: (p: Proposal) => void }) {
  const env = useEnv();
  const [text, setText] = useState(""); const [answers, setAnswers] = useState(""); const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<IntakeResult | null>(null); const [error, setError] = useState<ApiError | null>(null);
  const run = useMutation({
    mutationFn: (t: string) => api<IntakeResult>("POST", `/orgs/${org.id}/assistant/intake`, { text: t, timezone: userTimezone() }),
    onSuccess: (r) => { setError(null); setResult(r); if (r.state === "awaiting_publish_approval") onProposal(r.proposal); },
    onError: (e) => { setResult(null); setError(e as ApiError); },
  });

  if (env.isLoading) return null;
  if (!env.data?.aiAvailable) {
    return (
      <Card className="mb-6 grid gap-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-semibold">Describe it in your own words</h2><Badge tone="attention">AI assistant unavailable</Badge></div>
        <p className="text-sm text-text-muted">No AI provider is configured here. The form below works fully without it, and nothing about your request depends on AI.</p>
      </Card>
    );
  }
  const tooShort = touched && text.trim().length < 5;
  const submit = (t: string) => { setTouched(true); if (t.trim().length >= 5) run.mutate(t.trim()); };
  return (
    <Card className="mb-6 grid gap-3">
      <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-lg font-semibold">Describe it in your own words</h2><Badge tone="info">AI-assisted</Badge></div>
      <p className="text-sm text-text-muted">The assistant reads your description and proposes values for the form. It never saves, publishes, or contacts anyone. Your description is sent to the AI provider to be interpreted, so leave out anything you would not want processed there.</p>
      <Field label="What do you need?" hint="For example: 40 litres of palm oil to 12 Allen Avenue, Ikeja by Friday 5pm, at most NGN 120,000." error={tooShort ? "Write a sentence or two" : undefined}>
        {(a) => <Textarea {...a} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <div><Button type="button" variant="secondary" pending={run.isPending} onClick={() => submit(text)}>Fill the form from this description</Button></div>

      {error && <Alert tone={error.code === "AI_UNAVAILABLE" ? "attention" : "danger"} title={error.code === "AI_UNAVAILABLE" ? "AI assistant unavailable" : "The assistant could not run"}>{error.message} The form works without it.</Alert>}
      {result?.state === "awaiting_publish_approval" && (
        <Alert tone="info" title="The form was filled by AI from your description. Check every field.">
          Nothing has been saved. {result.assumptions.length > 0 && <span className="mt-1 block">Assumptions it made: {result.assumptions.join(" · ")}</span>}
        </Alert>
      )}
      {result?.state === "needs_clarification" && (
        <div className="grid gap-3 rounded-control border border-border p-4">
          <h3 className="font-semibold">The assistant needs a bit more</h3>
          <ul className="list-disc pl-5 text-sm">{result.questions.map((q) => <li key={q}>{q}</li>)}</ul>
          <Field label="Your answers">{(a) => <Textarea {...a} value={answers} onChange={(e) => setAnswers(e.target.value)} />}</Field>
          <div><Button type="button" variant="secondary" pending={run.isPending} disabled={!answers.trim()} onClick={() => { const t = `${text.trim()}\n\nAnswers: ${answers.trim()}`; setText(t); setAnswers(""); submit(t); }}>Try again with my answers</Button></div>
        </div>
      )}
      {result && (result.state === "failed" || result.state === "cancelled") && (
        <Alert tone={result.failure.assistantAvailable ? "danger" : "attention"} title={result.failure.assistantAvailable ? "The assistant could not finish" : "AI assistant unavailable"}>{result.failure.message}</Alert>
      )}
    </Card>
  );
}
