import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError } from "../api";
import { Alert, Button, Field, Input, Skeleton } from "../components/ui";
import { useEnv, useMe } from "../session";
import { AuthFrame } from "./Auth";

const forgotSchema = z.object({ email: z.string().trim().email("Enter a valid email address") });

export function ForgotPassword() {
  const env = useEnv();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema), mode: "onTouched" });
  const req = useMutation({
    mutationFn: (v: z.infer<typeof forgotSchema>) => api("POST", "/auth/password-reset/request", v),
    onSuccess: (_r, v) => setSentTo(v.email),
    onError: (e) => setErr(e as ApiError),
  });
  if (sentTo) {
    return (
      <AuthFrame title="Check your email" sub="If an account exists for that address, a reset link is on its way. The link works once and expires in 30 minutes.">
        {env.data?.devInbox && <Alert tone="info" title="Development environment">Nothing is emailed from here. Open the <Link className="font-medium underline" to={`/dev/inbox?to=${encodeURIComponent(sentTo)}`}>development inbox</Link> to find the link. The email worker must be running.</Alert>}
        <Link className="text-sm font-medium text-primary underline" to="/login">Back to sign in</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Reset your password" sub="Enter the email you signed up with. We say the same thing whether or not an account exists.">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setErr(null); req.mutate(v); })}>
        {err && <Alert tone="danger" title={err.code === "RATE_LIMITED" ? "Too many attempts" : "Could not send the request"}>{err.message}</Alert>}
        <Field label="Email" error={errors.email?.message}>{(a) => <Input {...a} type="email" autoComplete="email" {...register("email")} />}</Field>
        <Button type="submit" pending={req.isPending}>Send reset link</Button>
      </form>
      <Link className="text-sm font-medium text-primary underline" to="/login">Back to sign in</Link>
    </AuthFrame>
  );
}

const resetSchema = z.object({ password: z.string().min(12, "Use at least 12 characters").max(200), confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords do not match" });

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema), mode: "onTouched" });
  const confirm = useMutation({
    mutationFn: (v: z.infer<typeof resetSchema>) => api("POST", "/auth/password-reset/confirm", { token, password: v.password }),
    onSuccess: () => setDone(true),
    onError: (e) => setErr(e as ApiError),
  });
  if (!token) return <AuthFrame title="Reset your password"><Alert tone="danger" title="This link is incomplete">Open the link from your email again, or <Link className="underline" to="/forgot-password">ask for a new one</Link>.</Alert></AuthFrame>;
  if (done) {
    return (
      <AuthFrame title="Password changed">
        <Alert tone="success" title="You can sign in with your new password">For safety, every other session was signed out.</Alert>
        <Link className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover" to="/login">Continue to sign in</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Choose a new password" sub="At least 12 characters. A passphrase works well.">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit((v) => { setErr(null); confirm.mutate(v); })}>
        {err && <Alert tone="danger" title="This link did not work">{err.status === 0 ? err.message : <>It may be expired or already used. <Link className="underline" to="/forgot-password">Ask for a new link</Link>.</>}</Alert>}
        <Field label="New password" error={errors.password?.message}>{(a) => <Input {...a} type="password" autoComplete="new-password" {...register("password")} />}</Field>
        <Field label="Repeat the new password" error={errors.confirm?.message}>{(a) => <Input {...a} type="password" autoComplete="new-password" {...register("confirm")} />}</Field>
        <Button type="submit" pending={confirm.isPending}>Change password</Button>
      </form>
    </AuthFrame>
  );
}

/** Accepting is an explicit click, not an automatic call on page load: the token is single-use and a prefetch or double render must not spend it. */
export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const me = useMe();
  const [err, setErr] = useState<ApiError | null>(null);
  const accept = useMutation({
    mutationFn: () => api<{ orgId: string }>("POST", "/invitations/accept", { token }),
    onSuccess: async (r) => {
      try { localStorage.setItem("sp.activeOrg", r.orgId); } catch { /* storage unavailable: the first organisation is used */ }
      await qc.invalidateQueries({ queryKey: ["orgs"] });
      nav("/app", { replace: true });
    },
    onError: (e) => setErr(e as ApiError),
  });
  if (!token) return <AuthFrame title="Invitation"><Alert tone="danger" title="This link is incomplete">Open the link from your invitation email again.</Alert></AuthFrame>;
  if (me.isLoading) return <AuthFrame title="Invitation"><Skeleton className="h-10 w-full" /></AuthFrame>;
  if (!me.data) {
    return (
      <AuthFrame title="Sign in to accept" sub="Sign in with the email address the invitation was sent to. If you have no account yet, create one with that address first.">
        <Link className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-4 text-sm font-medium text-white hover:bg-primary-hover" to="/login" state={{ from: `${loc.pathname}${loc.search}` }}>Sign in</Link>
        <Link className="text-sm font-medium text-primary underline" to="/register">Create an account</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Accept the invitation" sub={`You are signed in as ${me.data.user.email}. The invitation only works for the address it was sent to.`}>
      {err && <Alert tone="danger" title="Could not accept">{err.message}</Alert>}
      <Button onClick={() => { setErr(null); accept.mutate(); }} pending={accept.isPending}>Join the organisation</Button>
      <p className="text-xs text-text-muted">Joining gives you the role the inviter chose. Their organisation can see your name and email.</p>
    </AuthFrame>
  );
}
