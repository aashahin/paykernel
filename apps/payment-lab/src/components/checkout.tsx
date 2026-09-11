"use client";
import { useEffect, useMemo, useState } from "react";
import { formatMinor } from "@/src/lib/format";
import type { GatewayReadiness } from "@/src/server/gateways/types";
import { createApiClient } from "@/src/lib/api-client";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Field } from "@/src/components/ui/field";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/src/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import StripePayment from "@/src/components/stripe-payment";
import MoyasarTokenForm from "@/src/components/moyasar-token-form";

const GATEWAYS = [
  { key: "stripe", label: "Stripe" },
  { key: "paypal", label: "PayPal" },
  { key: "paymob", label: "Paymob" },
  { key: "moyasar", label: "Moyasar" },
  { key: "tap", label: "Tap" },
  { key: "myfatoorah", label: "MyFatoorah" },
  { key: "hesabe", label: "Hesabe" },
] as const;
type GatewayKey = (typeof GATEWAYS)[number]["key"];
type Readiness = GatewayReadiness;
type CatalogItem = { sku: string; name: string; pricesMinor: Record<string, number> };
type CheckoutBox = { clientSecret?: string | undefined; redirectUrl?: string | undefined };

function fmt(minor: number, ccy: string) {
  return formatMinor(minor, ccy);
}
function errMsg(e: unknown) {
  return e instanceof Error ? e.message : "Request failed. Please retry.";
}

export default function Checkout() {
  const client = useMemo(() => createApiClient("/"), []);
  const [ready, setReady] = useState<Readiness[]>([]);
  const [pub, setPub] = useState<{ STRIPE_PUBLISHABLE_KEY?: string | undefined; MOYASAR_PUBLISHABLE_KEY?: string | undefined }>({});
  const [catalog, setCatalog] = useState<CatalogItem | null>(null);
  const [gateway, setGateway] = useState<GatewayKey>("stripe");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [phone, setPhone] = useState("");
  const [qty, setQty] = useState("1"); const [mode, setMode] = useState<"simulator" | "sandbox">("simulator");
  const [intent, setIntent] = useState<"automatic" | "manual">("automatic");
  const [stripeMethod, setStripeMethod] = useState<"elements" | "checkout">("elements");
  const [mfMethod, setMfMethod] = useState("INVOICE");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [idem] = useState(() => crypto.randomUUID());
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [box, setBox] = useState<CheckoutBox | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [loadErr, setLoadErr] = useState<string | null>(null);
  const cur = ready.find((r) => r.gateway === gateway);
  const manualOk = cur?.capabilities["authorization"] === true;
  const sandboxOk = cur?.configured === true;
  const ccy = cur?.defaultCurrency ?? "USD";
  const unit = catalog?.pricesMinor[ccy];
  const total = unit === undefined ? null : unit * Number(qty);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [g, c] = await Promise.all([client.api.gateways.$get(), client.api.catalog.$get()]);
        if (!g.ok || !c.ok) throw new Error("Failed to load checkout configuration.");
        const gj = await g.json(); const cj = await c.json();
        if (!live) return;
        setReady(gj.gateways);
        setPub(gj.publicConfig);
        setCatalog(cj.items[0] ?? null);
      } catch (e) { if (live) setLoadErr(errMsg(e)); }
      finally { if (live) setLoaded(true); }
    })();
    return () => { live = false; };
  }, [client]);
  useEffect(() => { if (!sandboxOk) setMode("simulator"); }, [sandboxOk]);
  useEffect(() => { if (!manualOk) setIntent("automatic"); if (gateway === "stripe" && stripeMethod === "checkout") setIntent("automatic"); }, [gateway, manualOk, stripeMethod]);

  async function start(token?: string) {
    setBusy(true); setError(null); setBox(null);
    try {
      if (!name.trim() || !email.trim()) throw new Error("Name and email are required.");
      if (mode === "sandbox" && gateway === "paymob" && phone.trim().length < 5) throw new Error("Phone is required for Paymob.");
      let oid = orderId;
      if (!oid) {
        const r = await client.api.orders.$post({ json: { name: name.trim(), email: email.trim(), gateway, quantity: Number(qty) } });
        if (!r.ok) throw new Error(`Create order failed (${r.status}). Order not created; retry safely.`);
        const j = await r.json(); oid = j.order.id; setOrderId(oid);
      }
      const method = gateway === "stripe" ? stripeMethod : gateway === "tap" ? "src_all" : gateway === "myfatoorah" ? mfMethod : gateway === "paypal" || gateway === "hesabe" ? "checkout" : undefined;
      const payload = { gateway, mode, captureIntent: intent, idempotencyKey: idem, ...(phone.trim() ? { phone: phone.trim() } : {}), ...(method ? { method } : {}), ...(token ? { sourceToken: token } : {}) };
      const p = await client.api.orders[":id"].pay.$post({ param: { id: oid }, json: payload });
      if (!p.ok) throw new Error(`Start payment failed (${p.status}). Order ${oid} kept; retry with same key.`);
      const pj = await p.json();
      setAttemptId(pj.attempt.id);
      const c = pj.checkout;
      setBox(c);
      if (c.redirectUrl && mode === "sandbox") {
        const u = new URL(c.redirectUrl, window.location.href);
        if (u.protocol !== "https:") throw new Error("Sandbox redirect blocked: provider URL must be HTTPS.");
        window.location.href = u.toString();
      }
    } catch (e) { setError(errMsg(e)); }
    finally { setBusy(false); }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading checkout…</p>;
  if (loadErr) return <Alert variant="destructive"><AlertDescription>{loadErr}</AlertDescription></Alert>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader><CardTitle>Payment</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <Tabs value={gateway} onValueChange={(v) => setGateway(v as GatewayKey)}>
            <TabsList className="flex w-full flex-wrap gap-1">
              {GATEWAYS.map((g) => <TabsTrigger disabled={!!orderId || busy} key={g.key} value={g.key}>{g.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          {!sandboxOk && <Alert><AlertDescription>Sandbox not configured{cur?.missing.length ? `: missing ${cur.missing.join(", ")}` : ""}. Using simulator. <a className="underline" href="/setup">Setup</a></AlertDescription></Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field><Label htmlFor="co-name">Name</Label><Input disabled={!!orderId || busy} id="co-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
            <Field><Label htmlFor="co-email">Email</Label><Input disabled={!!orderId || busy} id="co-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
            <Field><Label htmlFor="co-phone">Phone{gateway === "paymob" ? " (required)" : ""}</Label><Input disabled={!!orderId || busy} id="co-phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" required={gateway === "paymob"} /></Field>
            <Field><Label htmlFor="co-qty">Quantity (1–5)</Label>
              <Select disabled={!!orderId || busy} value={qty} onValueChange={setQty}><SelectTrigger id="co-qty"><SelectValue /></SelectTrigger>
              <SelectContent>{["1","2","3","4","5"].map((q) => <SelectItem key={q} value={q}>{q}</SelectItem>)}</SelectContent></Select></Field>
            <Field><Label htmlFor="co-mode">Mode</Label>
              <Select disabled={!!orderId || busy} value={mode} onValueChange={(v) => setMode(v as "simulator" | "sandbox")}><SelectTrigger id="co-mode"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="simulator">simulator</SelectItem><SelectItem value="sandbox" disabled={!sandboxOk}>sandbox</SelectItem></SelectContent></Select></Field>
            <Field><Label htmlFor="co-intent">Capture intent</Label>
              <Select disabled={!!orderId || busy} value={intent} onValueChange={(v) => setIntent(v as "automatic" | "manual")}><SelectTrigger id="co-intent"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="automatic">automatic</SelectItem><SelectItem value="manual" disabled={!manualOk || (gateway === "stripe" && stripeMethod === "checkout")}>manual</SelectItem></SelectContent></Select></Field>
            {gateway === "stripe" && <Field><Label htmlFor="co-sm">Stripe method</Label>
              <Select disabled={!!orderId || busy} value={stripeMethod} onValueChange={(v) => setStripeMethod(v as "elements" | "checkout")}><SelectTrigger id="co-sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="elements">Elements</SelectItem><SelectItem value="checkout">Hosted Checkout (automatic only)</SelectItem></SelectContent></Select></Field>}
            {gateway === "myfatoorah" && <Field><Label htmlFor="co-mf">MyFatoorah method</Label>
              <Select disabled={!!orderId || busy} value={mfMethod} onValueChange={setMfMethod}><SelectTrigger id="co-mf"><SelectValue /></SelectTrigger>
              <SelectContent>{(cur?.paymentMethods ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select></Field>}
          </div>
          {gateway === "moyasar" && mode === "sandbox" && <MoyasarTokenForm publishableKey={pub["MOYASAR_PUBLISHABLE_KEY"] ?? ""} holderName={name} pending={busy} onToken={(t) => start(t)} />}
          {error && <Alert variant="destructive"><AlertDescription>{error}{orderId ? ` Order ${orderId} kept.` : ""}</AlertDescription></Alert>}
          <div className="flex flex-wrap gap-2">
            {!(gateway === "moyasar" && mode === "sandbox") && <Button disabled={busy || !!attemptId} onClick={() => start()}>{busy ? "Working…" : orderId ? "Retry payment" : "Create order and pay"}</Button>}
            {orderId && <a className="text-sm underline underline-offset-4" href={`/orders/${orderId}`}>View order →</a>}
          </div>
          {box?.clientSecret && gateway === "stripe" && stripeMethod === "elements" && pub["STRIPE_PUBLISHABLE_KEY"] && attemptId && (
            <StripePayment clientSecret={box.clientSecret} publishableKey={pub["STRIPE_PUBLISHABLE_KEY"]} attemptId={attemptId} />
          )}
          {mode === "simulator" && attemptId && orderId && (
            <Alert><AlertDescription>Your simulated payment is ready for a tester to complete. <a className="underline" href={`/orders/${orderId}`}>View payment progress</a> · <a className="underline" href="/seller">Seller controls</a></AlertDescription></Alert>
          )}
        </CardContent>
      </Card>
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p className="font-medium">{catalog?.name ?? "Test notebook"}</p>
          <p className="text-muted-foreground">Currency {ccy} · Qty {qty}</p>
          <p className="money text-lg font-semibold">{total === null ? "Unavailable for currency" : fmt(total, ccy)}</p>
          <p className="text-xs text-muted-foreground">Unit {unit === undefined ? "—" : fmt(unit, ccy)} · {gateway} · {mode} · {intent}</p>
        </CardContent>
      </Card>
    </div>
  );
}
