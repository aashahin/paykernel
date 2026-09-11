"use client";
import { useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Field } from "@/src/components/ui/field";
import { Alert, AlertDescription } from "@/src/components/ui/alert";

type TokenOk = { id: string };
export default function MoyasarTokenForm({ publishableKey, holderName, pending, onToken }: { publishableKey: string; holderName: string; pending: boolean; onToken: (token: string) => void }) {
  const [name, setName] = useState(holderName);
  const [number, setNumber] = useState(""); const [month, setMonth] = useState(""); const [year, setYear] = useState(""); const [cvc, setCvc] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!publishableKey) return <Alert><AlertDescription>Moyasar publishable key missing. <a className="underline" href="/setup">Setup</a></AlertDescription></Alert>;
  return (
    <form action="https://api.moyasar.com/v1/tokens" method="POST" className="grid gap-3 rounded-lg border p-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try {
        const res = await fetch("https://api.moyasar.com/v1/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publishable_api_key: publishableKey, save_only: true, name, number, month, year, cvc }) });
        const body = (await res.json()) as Partial<TokenOk & { message: string }>;
        if (!res.ok || typeof body.id !== "string" || !body.id.startsWith("token_")) throw new Error(body.message || "Card tokenization failed.");
        setNumber(""); setMonth(""); setYear(""); setCvc("");
        onToken(body.id);
      } catch (ex) { setErr(ex instanceof Error ? ex.message : "Tokenization failed."); }
      finally { setBusy(false); }
    }}>
      <p className="text-xs text-muted-foreground">Card details are sent directly to Moyasar.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field><Label htmlFor="mo-name">Cardholder</Label><Input id="mo-name" value={name} onChange={(ev) => setName(ev.target.value)} autoComplete="cc-name" /></Field>
        <Field><Label htmlFor="mo-num">Card number</Label><Input id="mo-num" inputMode="numeric" value={number} onChange={(ev) => setNumber(ev.target.value)} autoComplete="cc-number" /></Field>
        <Field><Label htmlFor="mo-mm">Month</Label><Input id="mo-mm" inputMode="numeric" placeholder="MM" value={month} onChange={(ev) => setMonth(ev.target.value)} autoComplete="cc-exp-month" /></Field>
        <Field><Label htmlFor="mo-yy">Year</Label><Input id="mo-yy" inputMode="numeric" placeholder="YYYY" value={year} onChange={(ev) => setYear(ev.target.value)} autoComplete="cc-exp-year" /></Field>
        <Field><Label htmlFor="mo-cvc">CVC</Label><Input id="mo-cvc" type="password" inputMode="numeric" value={cvc} onChange={(ev) => setCvc(ev.target.value)} autoComplete="cc-csc" /></Field>
      </div>
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      <Button type="submit" disabled={busy || pending}>{busy ? "Tokenizing…" : "Tokenize and pay"}</Button>
    </form>
  );
}
