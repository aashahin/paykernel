"use client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { createApiClient } from "../lib/api-client";
import type { LabTestRun } from "../server/payments/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const GATEWAYS = ["stripe", "paypal", "paymob", "moyasar", "tap", "myfatoorah", "hesabe"] as const;
const MODES = ["sandbox", "simulator"] as const;
const scenariosSchema = z.object({ scenarios: z.array(z.object({ id: z.string(), label: z.string() })) });
const runSchema = z.object({ run: z.object({ id: z.string(), scenario: z.string(), gateway: z.string(), mode: z.string(), verdict: z.string(), evidenceJson: z.string(), createdAt: z.string(), updatedAt: z.string() }) });
const sel = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

async function errMsg(res: { status: number; text(): Promise<string> }, fb: string) {
  try {
    const t = await res.text();
    if (!t) return `${fb} (${res.status}).`;
    const p: unknown = JSON.parse(t);
    if (typeof p === "object" && p !== null && "error" in p && typeof p.error === "string" && p.error) return p.error;
    return `${fb} (${res.status}).`;
  } catch { return `${fb} (${res.status}).`; }
}

export function TestingWorkspace() {
  const [client] = useState(() => createApiClient("/"));
  const [scenarios, setScenarios] = useState<{ id: string; label: string }[]>([]);
  const [scenario, setScenario] = useState("");
  const [gateway, setGateway] = useState<string>("stripe");
  const [mode, setMode] = useState<string>("simulator");
  const [runs, setRuns] = useState<LabTestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRuns = useCallback(async () => {
    const res = await client.api.seller.runs.$get();
    if (!res.ok) throw new Error(await errMsg(res, "Failed to load history"));
    setRuns((await res.json()).runs);
  }, [client]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const sRes = await fetch("/api/seller/scenarios", { credentials: "same-origin" });
        if (!sRes.ok) throw new Error(await errMsg(sRes, "Failed to load scenarios"));
        const list = scenariosSchema.parse(await sRes.json()).scenarios;
        await loadRuns();
        if (live) { setScenarios(list); setScenario((v) => v || list[0]?.id || ""); }
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "Failed to load."); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [loadRuns]);
  async function run() {
    if (!scenario) { setError("Pick a scenario first."); return; }
    setRunning(true); setError(null);
    try {
      const res = await fetch("/api/seller/scenarios", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ gateway, mode, scenario }) });
      if (!res.ok) throw new Error(await errMsg(res, "Scenario run failed"));
      runSchema.parse(await res.json());
      await loadRuns();
    } catch (e) { setError(e instanceof Error ? e.message : "Scenario run failed."); }
    finally { setRunning(false); }
  }
  if (loading) return <Skeleton className="h-48 w-full" aria-label="Loading tests" />;
  return (
    <div className="grid gap-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Card><CardHeader><CardTitle>Run a scenario</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_180px_150px_auto]">
          <label className="grid gap-1 text-sm">Scenario<select className={sel} value={scenario} onChange={(e) => setScenario(e.target.value)}>{scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <label className="grid gap-1 text-sm">Gateway<select className={sel} value={gateway} onChange={(e) => setGateway(e.target.value)}>{GATEWAYS.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
          <label className="grid gap-1 text-sm">Mode<select className={sel} value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <Button type="button" className="self-end" disabled={running || !scenario} onClick={() => void run()}>{running ? "Running…" : "Run"}</Button>
        </CardContent></Card>
      <Card><CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>{runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : (
          <Table><TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Verdict</TableHead><TableHead>Evidence</TableHead></TableRow></TableHeader>
            <TableBody>{runs.map((r) => (
              <TableRow key={r.id}><TableCell><span className="block font-mono text-xs">{r.id}</span><span className="block text-xs text-muted-foreground">{r.scenario} · {r.gateway} · {r.mode}</span></TableCell>
                <TableCell><Badge variant={r.verdict === "passed" ? "default" : r.verdict === "running" ? "secondary" : "destructive"}>{r.verdict}</Badge></TableCell>
                <TableCell className="max-w-80"><RunEvidence json={r.evidenceJson} /></TableCell></TableRow>))}
            </TableBody></Table>)}</CardContent></Card>
    </div>
  );
}
export default TestingWorkspace;

function RunEvidence({ json }: { json: string }) {
  const evidence: unknown = JSON.parse(json);
  const orderId = evidence && typeof evidence === "object" && "orderId" in evidence && typeof evidence.orderId === "string" ? evidence.orderId : null;
  return <div className="grid gap-2">{orderId && <a className="underline" href={`/seller/orders/${encodeURIComponent(orderId)}`}>View order</a>}
    <details><summary className="cursor-pointer">View evidence</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(evidence, null, 2)}</pre></details></div>;
}
