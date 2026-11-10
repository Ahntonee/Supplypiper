import { Link } from "react-router-dom";
import { buttonClasses, Card, Wordmark } from "../components/ui";

const steps = [
  ["Request", "Describe what you need, where, by when, and your maximum landed cost."],
  ["Quotes", "Invited suppliers respond with exact charges. Pending replies show as pending."],
  ["Compare", "Landed totals are calculated by fixed rules, with every input shown."],
  ["Approve", "You approve one exact quote version and total. No AI approves for you."],
  ["Receive", "You confirm receipt or report a problem. Conflicting reports are kept."],
];

export default function Home() {
  return (
    <div className="min-h-svh bg-canvas">
      <header className="mx-auto flex max-w-[1120px] items-center justify-between px-4 py-4 sm:px-8">
        <Wordmark />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link className={buttonClasses("ghost")} to="/login">Sign in</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-[1120px] px-4 sm:px-8">
        <section className="grid gap-6 py-12 sm:py-20" aria-labelledby="headline">
          <p className="text-sm font-medium text-primary">Pilot access · palm oil · one delivery area</p>
          <h1 id="headline" className="max-w-3xl text-[36px] font-semibold leading-[1.1] sm:text-[52px]">Source clearly. Approve confidently.</h1>
          <p className="max-w-2xl text-lg text-text-muted">SupplyPiper helps small food businesses request supplies, compare real supplier quotations side by side, and approve an exact order. You stay in charge of every approval.</p>
          <div className="flex flex-wrap gap-3">
            <Link className={buttonClasses("primary")} to="/register">Request pilot access</Link>
            <a className={buttonClasses("secondary")} href="#accountability">How accountability works</a>
          </div>
        </section>

        <section aria-labelledby="flow" className="pb-12">
          <h2 id="flow" className="text-2xl font-semibold">How a request moves</h2>
          <p className="mt-1 text-sm text-text-muted">An illustration of the workflow, not live data.</p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map(([t, d], i) => (
              <li key={t}><Card className="h-full !p-4"><p className="text-xs font-medium text-primary">Step {i + 1}</p><h3 className="mt-1 font-semibold">{t}</h3><p className="mt-1 text-sm text-text-muted">{d}</p></Card></li>
            ))}
          </ol>
        </section>

        <section id="accountability" aria-labelledby="acc" className="grid gap-4 pb-16 sm:grid-cols-2">
          <Card>
            <h2 id="acc" className="text-2xl font-semibold">How agent accountability works</h2>
            <p className="mt-2 text-text-muted">A supplier can use an AI agent to prepare quotes. When agent verification is switched on, SupplyPiper checks the agent's registration on Concordium's public registry and records separately whether the supplier's organisation has authorised that agent. The check is repeated just before an order is committed.</p>
            <p className="mt-3 text-sm font-medium text-attention-text">Agent verification is not live yet. During the pilot, quotes are entered by people at the supplier and are labelled that way.</p>
          </Card>
          <Card>
            <h2 className="text-2xl font-semibold">What it does not prove</h2>
            <ul className="mt-2 list-disc pl-5 text-text-muted">
              <li>Product quality or that goods exist</li>
              <li>That a business is registered</li>
              <li>Ability to fulfil, or solvency</li>
              <li>Any endorsement by Concordium</li>
            </ul>
            <p className="mt-3 text-sm text-text-muted">Supplier statements are shown as the supplier's own. SupplyPiper is not an escrow or payment service.</p>
          </Card>
        </section>
      </main>

      <footer className="border-t border-border bg-surface px-4 py-6 text-sm text-text-muted sm:px-8">
        <div className="mx-auto max-w-[1120px]">SupplyPiper is in pilot development. It is built to work with Concordium's public Agent Registry and is not affiliated with or endorsed by Concordium.</div>
      </footer>
    </div>
  );
}
