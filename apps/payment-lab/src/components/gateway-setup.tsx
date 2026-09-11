"use client";
import { useEffect, useState } from "react";
import { createApiClient } from "../lib/api-client";
import type { GatewayReadiness } from "../server/gateways/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

export default function GatewaySetup() {
  const [client] = useState(() => createApiClient("/"));
  const [gateways, setGateways] = useState<GatewayReadiness[]>([]);
  const [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await client.api.gateways.$get();
        if (!res.ok) throw new Error(`Failed to load readiness (${res.status}).`);
        const data = await res.json();
        if (live) setGateways(data.gateways);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "Failed to load."); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [client]);
  if (loading) return <Skeleton className="h-48 w-full" aria-label="Loading gateway setup" />;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle>Secrets live in wrangler, never in this UI</CardTitle>
        <CardDescription>This page is read-only — there is no credential input form.</CardDescription></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">wrangler secret put STRIPE_SECRET_KEY --config wrangler.jsonc</pre>
          <p className="text-xs text-muted-foreground">Set each missing secret name shown below, then redeploy. Public keys are presence-only (never values).</p>
        </CardContent></Card>
      {gateways.map((g) => {
        const caps = Object.entries(g.capabilities).filter(([, v]) => v).map(([k]) => k);
        const webhook = `${origin}/api/webhooks/${g.gateway}`;
        return (
          <Card key={g.gateway}><CardHeader><CardTitle className="flex items-center gap-2 text-base">{g.gateway}
            <Badge variant={g.configured ? "default" : "destructive"}>{g.configured ? "ready" : "missing secrets"}</Badge>
            <Badge variant="outline">{g.defaultCurrency}</Badge></CardTitle>
            <CardDescription>Webhook: <code className="font-mono">{webhook}</code></CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {g.gateway === "paymob" && <p className="text-xs text-muted-foreground">Paymob return/callback is per attempt: <code className="font-mono">POST {origin}/api/returns/:attemptId</code> (shared callback URL per attempt).</p>}
              {g.missing.length > 0 ? <p>Missing secrets: {g.missing.map((m) => <code key={m} className="mr-1 font-mono">{m}</code>)}</p> : <p className="text-muted-foreground">All required secrets present.</p>}
              {Object.keys(g.publicKeys).length > 0 && <p className="text-xs">Public keys: {Object.entries(g.publicKeys).map(([k, v]) => <span key={k} className="mr-2">{k}: {v ? "present" : "absent"}</span>)}</p>}
              <p className="text-xs text-muted-foreground">Capabilities: {caps.length ? caps.join(", ") : "none"} · Methods: {g.paymentMethods.join(", ")}</p>
            </CardContent></Card>
        );
      })}
    </div>
  );
}
