"use client";
import { useState } from "react";
import { createApiClient } from "../lib/api-client";
import type { OrderDetail } from "../server/payment-service";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type Full = OrderDetail["attempts"][number];
type Attempt = Pick<Full, "id" | "mode" | "status" | "captureIntent" | "refunds">;
type Outcome = "paid" | "authorized" | "failed" | "cancelled" | "pending";

async function errMsg(res: { status: number; text(): Promise<string> }, fb: string) {
  try {
    const t = await res.text();
    if (!t) return `${fb} (${res.status}).`;
    const p: unknown = JSON.parse(t);
    if (typeof p === "object" && p !== null && "error" in p && typeof p.error === "string" && p.error) return p.error;
    return `${fb} (${res.status}).`;
  } catch { return `${fb} (${res.status}).`; }
}

export default function SimulatorControls({ attempt, onChanged }: { attempt: Attempt; onChanged?: () => void | Promise<void> }) {
  const [client] = useState(() => createApiClient("/"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (attempt.mode !== "simulator") return null;
  const primary: Outcome = attempt.captureIntent === "manual" ? "authorized" : "paid";
  async function sendPayment(outcome: Outcome) {
    setBusy(outcome); setError(null);
    try {
      const res = await client.api.seller.simulator[":id"].$post({ param: { id: attempt.id }, json: { kind: "payment", outcome, deliver: true } });
      if (!res.ok) throw new Error(await errMsg(res, "Simulated action failed"));
      const data = await res.json();
      if (data.delivery && !data.delivery.ok) throw new Error("Provider state changed; webhook delivery needs retry. Reconcile or retry delivery.");
      await onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Simulated action failed."); }
    finally { setBusy(null); }
  }
  async function settleRefund(refundId: string) {
    setBusy(`refund:${refundId}`); setError(null);
    try {
      const res = await client.api.seller.simulator[":id"].$post({ param: { id: attempt.id }, json: { kind: "refund", refundId, outcome: "completed", deliver: true } });
      if (!res.ok) throw new Error(await errMsg(res, "Refund settle failed"));
      const data = await res.json();
      if (data.delivery && !data.delivery.ok) throw new Error("Provider state changed; webhook delivery needs retry. Reconcile or retry delivery.");
      await onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Refund settle failed."); }
    finally { setBusy(null); }
  }
  const pending = attempt.refunds.filter((r) => r.status === "pending");
  return (
    <Card><CardHeader><CardTitle className="text-base">Simulator actions</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-xs text-muted-foreground">Isolated simulated actions only — no real money moves. The full flow still goes through the signed HTTP backend.</p>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null || !["pending", "processing", "approved"].includes(attempt.status)} onClick={() => void sendPayment(primary)}>{attempt.captureIntent === "manual" ? "Authorize hold" : "Complete as paid"}</Button>
          <Button size="sm" variant="outline" disabled={busy !== null || !["pending", "processing", "approved"].includes(attempt.status)} onClick={() => void sendPayment("failed")}>Decline</Button>
          <Button size="sm" variant="outline" disabled={busy !== null || !["pending", "processing", "approved"].includes(attempt.status)} onClick={() => void sendPayment("cancelled")}>Cancel</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null || !["pending", "processing", "approved"].includes(attempt.status)} onClick={() => void sendPayment("pending")}>Keep pending</Button>
        </div>
        {pending.map((r) => (
          <div key={r.providerRefundId} className="flex items-center gap-2 text-sm">
            <span className="font-mono text-xs">{r.providerRefundId}</span>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void settleRefund(r.providerRefundId)}>Settle refund</Button>
          </div>
        ))}
      </CardContent></Card>
  );
}
