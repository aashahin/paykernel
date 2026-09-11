"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "../lib/auth-client";
import { createApiClient } from "../lib/api-client";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

const api = createApiClient("/");

function SignInForm() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError("");
    setPending(true);
    try {
      const signInResponse = await authClient.signIn.email({
        email: String(fields.get("email")), password: String(fields.get("password")),
      });
      if (signInResponse.error) setError(signInResponse.error.message ?? "Unable to sign in.");
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
    } finally { setPending(false); }
  }
  return (
    <section className="mx-auto flex w-full max-w-sm flex-col gap-7 py-12">
      <div><p className="eyebrow">Seller workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-3 text-sm text-muted-foreground">Sign in to manage test orders and payment workflows.</p></div>
      <form onSubmit={signIn}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="seller-email">Email</FieldLabel><Input id="seller-email" name="email" type="email" autoComplete="username" required /></Field>
          <Field><FieldLabel htmlFor="seller-password">Password</FieldLabel><Input id="seller-password" name="password" type="password" autoComplete="current-password" required /></Field>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
        </FieldGroup>
      </form>
      <p className="text-xs text-muted-foreground">Access is limited to provisioned testers. <a className="underline" href="/setup">View setup instructions</a></p>
    </section>
  );
}

export function SellerAccess({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const [access, setAccess] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const [signOutError, setSignOutError] = useState("");
  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setAccess("loading");
    void api.api.session.$get({}, { init: { signal: controller.signal } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session lookup failed");
        const profile = await response.json();
        if (!controller.signal.aborted) setAccess(profile.authenticated && profile.seller ? "allowed" : "denied");
      })
      .catch(() => { if (!controller.signal.aborted) setAccess("error"); });
    return () => controller.abort();
  }, [userId]);
  if (isPending || (session && access === "loading")) return <Skeleton className="h-48 w-full" aria-label="Loading seller session" />;
  if (!session) return <SignInForm />;
  async function signOut() {
    try {
      const response = await authClient.signOut();
      if (response.error) setSignOutError(response.error.message ?? "Unable to sign out.");
    } catch { setSignOutError("Could not reach the sign-in service. Please try again."); }
  }
  return <div className="flex flex-col gap-6">
    <div className="flex items-center justify-between gap-4 text-sm"><span className="text-muted-foreground">{session.user.email}</span><Button type="button" variant="ghost" size="sm" onClick={signOut}>Sign out</Button></div>
    {signOutError && <Alert variant="destructive"><AlertDescription>{signOutError}</AlertDescription></Alert>}
    {access === "allowed" ? children : <Alert variant="destructive"><AlertDescription>{access === "denied" ? "This account does not have seller access." : "Could not verify seller access. Reload to try again."}</AlertDescription></Alert>}
  </div>;
}
