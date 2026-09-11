"use client";
import { useEffect, useMemo, useState } from "react";
import { formatMinor } from "@/src/lib/format";
import type { InferResponseType } from "hono/client";
import { createApiClient } from "@/src/lib/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/src/components/ui/empty";
import { Button } from "@/src/components/ui/button";
import StripePayment from "./stripe-payment";

type Detail = InferResponseType<ReturnType<typeof createApiClient>["api"]["orders"][":id"]["$get"], 200>;
const PENDING = new Set(["pending", "processing"]);
const MAX_POLLS = 20;

export default function PaymentProgress({ orderId }: { orderId: string }) {
  const client = useMemo(() => createApiClient("/"), []);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true; let n = 0;
    async function load() {
      try {
        const r = await client.api.orders[":id"].$get({ param: { id: orderId } });
        if (!r.ok) throw new Error(`Order lookup failed (${r.status}).`);
        const j = await r.json();
        if (!live) return;
        setData(j); setError(null); n += 1; setPolls(n);
        const active = j.attempts.some((a) => PENDING.has(a.status) || a.ambiguous || a.refunds.some(refund => refund.status === "pending"));
        if (!active || n >= MAX_POLLS) { if (timer) clearInterval(timer); }
      } catch (e) { if (live) { setError(e instanceof Error ? e.message : "Load failed."); if (timer) clearInterval(timer); } }
    }
    void load();
    const timer = setInterval(load, 3000);
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [client, orderId, refresh]);
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading order…</p>;
  if (data.attempts.length === 0) return <Empty><EmptyHeader><EmptyTitle>No payment attempts</EmptyTitle><EmptyDescription>Start a checkout to create the first attempt.</EmptyDescription></EmptyHeader></Empty>;
  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle>Order {data.order.id}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <span>Fulfillment: <Badge variant="secondary">{data.order.fulfillment}</Badge></span>
          <span className="money">Total {formatMinor(data.order.totalMinor, data.order.currency)}</span>
          <span className="text-muted-foreground">{polls >= MAX_POLLS ? "Automatic checks paused." : "Status checked automatically"}</span>
          <Button size="sm" variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh status</Button>
        </CardContent></Card>
      {data.attempts.map((a) => (
        <Card key={a.id}><CardHeader><CardTitle className="text-base">Attempt {a.id}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex flex-wrap gap-2"><Badge>{a.status}</Badge><Badge variant="outline">{a.gateway}</Badge><Badge variant="outline">{a.mode}</Badge><Badge variant="outline">{a.captureIntent}</Badge></div>
            <p className="money">Amount {formatMinor(a.amountMinor,a.currency)} · Captured {formatMinor(a.capturedMinor,a.currency)} · Refunded {formatMinor(a.refundedMinor,a.currency)}</p>
            {a.checkout.redirectUrl?.startsWith("https://") && <a className="underline" href={a.checkout.redirectUrl}>Continue payment</a>}
            {a.gateway === "stripe" && a.checkout.clientSecret && data.stripePublishableKey && <StripePayment clientSecret={a.checkout.clientSecret} publishableKey={data.stripePublishableKey} attemptId={a.id} />}
            <p>Operations: {a.operations.length ? a.operations.map((o) => `${o.kind}:${o.status}`).join(", ") : "none"}</p>
            <p>Refunds: {a.refunds.length ? a.refunds.map((r) => `${formatMinor(r.amountMinor,a.currency)}:${r.status}`).join(", ") : "none"}</p>
            <div><p className="font-medium">Timeline</p>
              {a.webhooks.length === 0 ? <p className="text-muted-foreground">No webhooks yet.</p> : <ul className="list-disc pl-5">{a.webhooks.map((w) => <li key={w.id}>{w.createdAt} · {w.status} · {w.effect}</li>)}</ul>}
            </div>
          </CardContent></Card>
      ))}
    </div>
  );
}
