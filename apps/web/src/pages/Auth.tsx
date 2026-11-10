import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError, setCsrf, type Me } from "../api";
import { Alert, Button, Card, Field, Input, Skeleton, Wordmark } from "../components/ui";
import { useEnv } from "../session";

function AuthFrame({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  const env = useEnv();
  return (
    <div className="min-h-svh bg-canvas">
      {env.data?.banner && <div role="status" className="bg-attention-bg px-4 py-2 text-center text-sm font-medium text-attention-text">{env.data.banner}</div>}
      <div className="mx-auto grid max-w-md gap-6 px-4 py-10">
        <Link to="/" className="justify-self-start"><Wordmark /></Link>
        <Card className="grid gap-5">
          <div><h1 className="text-[28px] font-semibold">{title}</h1>{sub && <p className="mt-1 text-sm text-text-muted">{sub}</p>}</div>
          {children}
        </Card>
      </div>
    </div>
  );
}

const loginSchema = z.object({ email: z.string().trim().email("Enter a valid email address"), password: z.string().min(1, "Enter your password") });

export function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<ApiError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema), mode: "onTouched" });
  const login = useMutation({
    mutationFn: (v: z.infer<typeof loginSchema>) => api<{ csrfToken: string }>("POST", "/auth/login", v),
    onSuccess: async (r) => { setCsrf(r.csrfToken); await qc.invalidateQueries({ queryKey: ["me"] }); nav((loc.state as { from?: string } | null)?.from ?? "/app", { replace: true }); },
    onError: (e) => setFormError(e as ApiError),
  });
  return (
    <AuthFrame title="Sign in" sub="Use the email you verified when you created your account.">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setFormError(null); login.mutate(v); })}>
        {formError && (
          <Alert tone="danger" title={formError.code === "EMAIL_NOT_VERIFIED" ? "Verify your email first" : formError.code === "RATE_LIMITED" ? "Too many attempts" : "Could not sign in"}>
            {formError.message}{formError.correlationId && <span className="mt-1 block text-xs">Reference: {formError.correlationId}</span>}
          </Alert>
        )}
        <Field label="Email" error={errors.email?.message}>{(a) => <Input {...a} type="email" autoComplete="email" {...register("email")} />}</Field>
        <Field label="Password" error={errors.password?.message}>{(a) => <Input {...a} type="password" autoComplete="current-password" {...register("password")} />}</Field>
        <Button type="submit" pending={login.isPending}>Sign in</Button>
      </form>
      <p className="text-sm text-text-muted">New to SupplyPiper? <Link className="font-medium text-primary underline" to="/register">Request pilot access</Link></p>
    </AuthFrame>
  );
}

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name").max(100),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(12, "Use at least 12 characters"),
});

export function Register() {
  const env = useEnv();
  const [done, setDone] = useState<string | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema), mode: "onTouched" });
  const reg = useMutation({
    mutationFn: (v: z.infer<typeof registerSchema>) => api("POST", "/auth/register", v),
    onSuccess: (_r, v) => setDone(v.email),
    onError: (e) => {
      const err = e as ApiError;
      setFormError(err);
      for (const [k, m] of Object.entries(err.details)) if (k in registerSchema.shape) setError(k as keyof z.infer<typeof registerSchema>, { message: m });
    },
  });
  if (done) {
    return (
      <AuthFrame title="Check your email" sub={`We sent a verification link to ${done}. Verifying proves you control this address; it is not an identity check.`}>
        <Alert tone="info" title="No email provider is connected yet">
          {env.data?.devInbox ? <>In this development environment, open the <Link className="font-medium underline" to={`/dev/inbox?to=${encodeURIComponent(done)}`}>development inbox</Link> to find your link.</> : "Real email delivery is not switched on in this environment, so ask the operator to send your link."}
        </Alert>
        <Link className="text-sm font-medium text-primary underline" to="/login">Back to sign in</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Request pilot access" sub="Pilot access is limited. Create an account to join; you can draft requests before any verification.">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setFormError(null); reg.mutate(v); })}>
        {formError && formError.code !== "VALIDATION_FAILED" && <Alert tone="danger" title="Could not create the account">{formError.message}</Alert>}
        <Field label="Your name" error={errors.displayName?.message}>{(a) => <Input {...a} autoComplete="name" {...register("displayName")} />}</Field>
        <Field label="Work email" error={errors.email?.message}>{(a) => <Input {...a} type="email" autoComplete="email" {...register("email")} />}</Field>
        <Field label="Password" hint="At least 12 characters. A passphrase works well." error={errors.password?.message}>{(a) => <Input {...a} type="password" autoComplete="new-password" {...register("password")} />}</Field>
        <Button type="submit" pending={reg.isPending}>Create account</Button>
      </form>
      <p className="text-sm text-text-muted">Already have an account? <Link className="font-medium text-primary underline" to="/login">Sign in</Link></p>
    </AuthFrame>
  );
}

/** One request per single-use token, shared by every effect run (React StrictMode runs effects twice in development). */
const verifying = new Map<string, Promise<unknown>>();
const verifyOnce = (token: string) => {
  let p = verifying.get(token);
  if (!p) { p = api("POST", "/auth/verify-email", { token }); verifying.set(token, p); }
  return p;
};

export function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"working" | "ok" | "bad" | "offline">(token ? "working" : "bad");
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    verifyOnce(token)
      .then(() => !cancelled && setState("ok"))
      .catch((e) => !cancelled && setState(e instanceof ApiError && e.status === 0 ? "offline" : "bad"));
    return () => { cancelled = true; };
  }, [token]);
  return (
    <AuthFrame title="Email verification">
      {state === "working" && <Skeleton className="h-10 w-full" />}
      {state === "ok" && <><Alert tone="success" title="Email verified">You can sign in now.</Alert><Link className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover" to="/login">Continue to sign in</Link></>}
      {state === "bad" && <Alert tone="danger" title="This link did not work">It may be expired or already used. Create an account again or contact the operator for a new link.</Alert>}
      {state === "offline" && <Alert tone="attention" title="Could not reach the server">Check your connection and reload this page; the link has not been used up.</Alert>}
    </AuthFrame>
  );
}

interface Mail { id: string; createdAt: string; to: string; template: string; data: Record<string, string> }
export function DevInbox() {
  const [params] = useSearchParams();
  const to = params.get("to") ?? "";
  const env = useEnv();
  const q = useQuery({ queryKey: ["dev-inbox", to], enabled: !!env.data?.devInbox, queryFn: () => api<{ emails: Mail[] }>("GET", `/dev/inbox${to ? `?to=${encodeURIComponent(to)}` : ""}`) });
  const link = (m: Mail) => m.template === "verify_email" ? `/verify?token=${encodeURIComponent(m.data.token ?? "")}` : null;
  return (
    <AuthFrame title="Development inbox" sub="Local development only. Real addresses never receive mail from this environment.">
      {!env.isLoading && !env.data?.devInbox && <Alert tone="attention" title="Not available">The development inbox is switched off here.</Alert>}
      {q.isLoading && env.data?.devInbox && <Skeleton className="h-16 w-full" />}
      {q.data?.emails.length === 0 && <p className="text-sm text-text-muted">No messages yet.</p>}
      <ul className="grid gap-3">
        {q.data?.emails.map((m) => (
          <li key={m.id} className="rounded-control border border-border p-3 text-sm">
            <p className="font-medium">{m.template.replaceAll("_", " ")} → {m.to}</p>
            {link(m) ? <Link className="break-all text-primary underline" to={link(m)!}>Open verification link</Link> : <p className="text-text-muted">No link for this template in the web app yet.</p>}
          </li>
        ))}
      </ul>
    </AuthFrame>
  );
}

export type { Me };
