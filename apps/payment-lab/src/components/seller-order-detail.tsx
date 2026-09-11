"use client";

import SimulatorControls from "./simulator-controls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../lib/api-client";
import { formatMinor, statusLabel } from "../lib/format";
import type { OrderDetail } from "../server/payment-service";
import type { GatewayReadiness } from "../server/gateways/types";
import type { LabFulfillment } from "../server/payments/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Textarea } from "./ui/textarea";

type Detail = OrderDetail;
type Attempt = Detail["attempts"][number];

const FULFILLMENTS: LabFulfillment[] = ["unfulfilled", "processing", "shipped", "delivered", "cancelled"];

function isFulfillment(value: string): value is LabFulfillment {
  return (
    value === "unfulfilled" ||
    value === "processing" ||
    value === "shipped" ||
    value === "delivered" ||
    value === "cancelled"
  );
}

function exponentFor(currency: string): number {
  try {
    const fmt = new Intl.NumberFormat("en", { style: "currency", currency });
    return fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function majorToMinor(majorText: string, currency: string): number | null {
  const exp = exponentFor(currency);
  const value = majorText.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > exp) return null;
  const minor = Number(whole + fraction.padEnd(exp, "0"));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

async function responseMessage(res: { status: number; text(): Promise<string> }, fallback: string): Promise<string> {
  try {
    const raw = await res.text();
    if (!raw) return `${fallback} (${res.status}).`;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const err: unknown = parsed.error;
      if (typeof err === "string" && err.length > 0) return err;
    }
    return `${fallback} (${res.status}).`;
  } catch {
    return `${fallback} (${res.status}).`;
  }
}

function captureStatusOk(status: string): boolean {
  return status === "authorized" || status === "partially_captured";
}
function voidStatusOk(status: string): boolean {
  return status === "authorized";
}
function refundStatusOk(status: string): boolean {
  return status === "paid" || status === "partially_captured" || status === "partially_refunded";
}
function needsReconcile(a: Attempt): boolean {
  if (a.ambiguous) return true;
  if (a.pendingOperationId !== undefined) return true;
  if (a.status === "pending" || a.status === "processing") return true;
  if (a.operations.some((o) => o.status === "pending" || o.status === "indeterminate" || o.status === "submitted")) return true;
  if (a.refunds.some((r) => r.status === "pending")) return true;
  return false;
}

export default function SellerOrderDetail({ orderId }: { orderId: string }) {
  const [client] = useState(() => createApiClient("/"));
  const [detail, setDetail] = useState<Detail | null>(null);
  const [gateways, setGateways] = useState<GatewayReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [notesDraft, setNotesDraft] = useState("");
  const [fulfillmentDraft, setFulfillmentDraft] = useState<LabFulfillment>("unfulfilled");
  const [editingItems, setEditingItems] = useState(false);
  const [currencyDraft, setCurrencyDraft] = useState("USD");
  const [itemDrafts, setItemDrafts] = useState<{ name: string; quantity: string; unitMajor: string }[]>([]);
  const requestKeys = useRef(new Map<string, string>());
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dRes, gRes] = await Promise.all([
        client.api.seller.orders[":id"].$get({ param: { id: orderId } }),
        client.api.gateways.$get(),
      ]);
      if (!dRes.ok) throw new Error(await responseMessage(dRes, "Failed to load order"));
      if (!gRes.ok) throw new Error(await responseMessage(gRes, "Failed to load gateway capabilities"));
      const data = await dRes.json();
      const g = await gRes.json();
      setDetail(data);
      setGateways(g.gateways);
      setNotesDraft(data.order.notes);
      setFulfillmentDraft(data.order.fulfillment);
      setCurrencyDraft(data.order.currency);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order.");
    } finally {
      setLoading(false);
    }
  }, [client, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const awaitingSettlement = detail?.attempts.some(needsReconcile) ?? false;
  useEffect(() => {
    if (!awaitingSettlement || busy !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      try {
        if (document.visibilityState === "visible") {
          const res = await client.api.seller.orders[":id"].$get({ param: { id: orderId } });
          if (res.ok) {
            const data = await res.json();
            // Refresh payment evidence without replacing unsaved order edits.
            if (!cancelled) setDetail(data);
          }
        }
      } catch {
        // Keep the last confirmed state and retry after a transient read failure.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 5_000);
      }
    }
    timer = setTimeout(() => void poll(), 5_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [awaitingSettlement, busy, client, orderId]);

  const readinessByGateway = useMemo(() => {
    const map = new Map<string, GatewayReadiness>();
    for (const r of gateways) map.set(r.gateway, r);
    return map;
  }, [gateways]);

  async function refreshQuiet(): Promise<void> {
    try {
      const res = await client.api.seller.orders[":id"].$get({ param: { id: orderId } });
      if (!res.ok) throw new Error(await responseMessage(res, "Refresh failed"));
      const data = await res.json();
      setDetail(data);
      setNotesDraft(data.order.notes);
      setFulfillmentDraft(data.order.fulfillment);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Refresh failed.");
    }
  }

  async function saveNotes(): Promise<void> {
    if (!detail) return;
    setBusy("notes");
    setNotice(null);
    try {
      const res = await client.api.seller.orders[":id"].$patch({
        param: { id: orderId },
        json: { action: "notes", expectedVersion: detail.order.version, notes: notesDraft },
      });
      if (!res.ok) throw new Error(await responseMessage(res, "Saving notes failed"));
      await refreshQuiet();
      setNotice("Notes saved.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Saving notes failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveFulfillment(): Promise<void> {
    if (!detail) return;
    setBusy("fulfillment");
    setNotice(null);
    try {
      const res = await client.api.seller.orders[":id"].$patch({
        param: { id: orderId },
        json: { action: "fulfillment", expectedVersion: detail.order.version, fulfillment: fulfillmentDraft },
      });
      if (!res.ok) throw new Error(await responseMessage(res, "Saving fulfillment failed"));
      await refreshQuiet();
      setNotice("Fulfillment updated.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Saving fulfillment failed.");
    } finally {
      setBusy(null);
    }
  }

  function startItemEdit(): void {
    if (!detail) return;
    setCurrencyDraft(detail.order.currency);
    setItemDrafts(
      detail.order.items.map((it) => ({
        name: it.name,
        quantity: String(it.quantity),
        unitMajor: (it.unitMinor / 10 ** exponentFor(detail.order.currency)).toFixed(exponentFor(detail.order.currency)),
      })),
    );
    setEditingItems(true);
  }

  async function saveItems(): Promise<void> {
    if (!detail) return;
    const ccy = currencyDraft.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      setNotice("Currency must be a 3-letter code such as USD.");
      return;
    }
    const items: { name: string; quantity: number; unitMinor: number }[] = [];
    for (const d of itemDrafts) {
      const qty = Number(d.quantity);
      const unitMinor = majorToMinor(d.unitMajor, ccy);
      if (!Number.isInteger(qty) || qty <= 0) {
        setNotice("Each item needs a positive integer quantity.");
        return;
      }
      if (unitMinor === null) {
        setNotice(`Invalid unit price for "${d.name || "item"}". Enter a positive amount in ${ccy} major units.`);
        return;
      }
      if (!d.name.trim()) {
        setNotice("Each item needs a name.");
        return;
      }
      items.push({ name: d.name.trim(), quantity: qty, unitMinor });
    }
    if (items.length === 0) {
      setNotice("Add at least one item.");
      return;
    }
    setBusy("items");
    setNotice(null);
    try {
      const res = await client.api.seller.orders[":id"].$patch({
        param: { id: orderId },
        json: { action: "items", expectedVersion: detail.order.version, currency: ccy, items },
      });
      if (!res.ok) throw new Error(await responseMessage(res, "Saving items failed"));
      setEditingItems(false);
      await refreshQuiet();
      setNotice("Items saved.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Saving items failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runAction(attempt: Attempt, kind: "capture" | "void" | "refund", full: boolean): Promise<void> {
    const key = `${kind}:${attempt.id}`;
    const raw = (amounts[attempt.id] ?? "").trim();
    let amountMinor: number | undefined;
    if ((kind === "capture" || kind === "refund") && !full) {
      const parsed = majorToMinor(raw, attempt.currency);
      if (parsed === null) {
        setNotice(`Enter a positive ${attempt.currency} amount in major units (for example 10.00).`);
        return;
      }
      amountMinor = parsed;
    }
    const request = `${key}:${amountMinor ?? "remaining"}`;
    const idempotencyKey = requestKeys.current.get(request) ?? crypto.randomUUID();
    requestKeys.current.set(request, idempotencyKey);
    setBusy(key);
    setNotice(null);
    try {
      const res = await client.api.seller.attempts[":id"].actions.$post({
        param: { id: attempt.id },
        json: {
          kind,
          idempotencyKey,
          ...(amountMinor !== undefined ? { amountMinor } : {}),
        },
      });
      if (!res.ok) throw new Error(await responseMessage(res, `${kind} failed`));
      await refreshQuiet();
      requestKeys.current.delete(request);
      setNotice(`${statusLabel(kind)} submitted.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : `${kind} failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function reconcile(attempt: Attempt): Promise<void> {
    setBusy(`reconcile:${attempt.id}`);
    setNotice(null);
    try {
      const res = await client.api.seller.attempts[":id"].reconcile.$post({ param: { id: attempt.id } });
      if (!res.ok) throw new Error(await responseMessage(res, "Reconcile failed"));
      const result = await res.json();
      await refreshQuiet();
      setNotice(result.attempt.pendingOperationId
        ? "The payment provider has not confirmed the operation outcome yet. It remains locked to prevent a duplicate."
        : "Reconciliation complete; latest status loaded.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Reconcile failed.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-3" aria-label="Loading order detail">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !detail) {
    return <Alert variant="destructive"><AlertDescription>{error ?? "Order not found."}</AlertDescription></Alert>;
  }

  const hasAttempts = detail.attempts.length > 0;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 [&_[data-slot=card-title]]:break-all [&_[data-slot=card-content]]:min-w-0 [&_[data-slot=card-content]>div]:min-w-0">
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle>Order {detail.order.id}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p><span className="text-muted-foreground">Customer:</span> {detail.order.customerName} · {detail.order.customerEmail}</p>
          <p className="money"><span className="text-muted-foreground">Total:</span> {formatMinor(detail.order.totalMinor, detail.order.currency)} {detail.order.currency}</p>
          <div className="flex flex-wrap gap-2">
            <span>Fulfillment: <Badge variant="secondary">{statusLabel(detail.order.fulfillment)}</Badge></span>
            <span>Version: <Badge variant="outline">v{detail.order.version}</Badge></span>
          </div>
          <p className="text-xs text-muted-foreground">Financial status lives on each payment attempt below; fulfillment never implies payment.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Items</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <Table>
            <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Qty</TableHead><TableHead>Unit</TableHead><TableHead>Line</TableHead></TableRow></TableHeader>
            <TableBody>
              {detail.order.items.map((it, i) => (
                <TableRow key={`${it.name}-${i}`}>
                  <TableCell>{it.name}</TableCell>
                  <TableCell>{it.quantity}</TableCell>
                  <TableCell className="money">{formatMinor(it.unitMinor, detail.order.currency)}</TableCell>
                  <TableCell className="money">{formatMinor(it.quantity * it.unitMinor, detail.order.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hasAttempts ? (
            <p className="text-xs text-muted-foreground">Items are locked after a payment attempt starts. The server rejects edits to keep totals consistent.</p>
          ) : editingItems ? (
            <div className="grid gap-3">
              <Field><FieldLabel htmlFor="detail-ccy">Currency</FieldLabel><Input id="detail-ccy" value={currencyDraft} onChange={(e) => setCurrencyDraft(e.target.value.toUpperCase())} maxLength={3} /></Field>
              {itemDrafts.map((d, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_90px_140px_auto]">
                  <Input aria-label={`Item ${i + 1} name`} value={d.name} onChange={(e) => setItemDrafts((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))} />
                  <Input aria-label={`Item ${i + 1} quantity`} value={d.quantity} onChange={(e) => setItemDrafts((prev) => prev.map((p, j) => (j === i ? { ...p, quantity: e.target.value } : p)))} inputMode="numeric" />
                  <Input aria-label={`Item ${i + 1} unit price in major units`} value={d.unitMajor} onChange={(e) => setItemDrafts((prev) => prev.map((p, j) => (j === i ? { ...p, unitMajor: e.target.value } : p)))} inputMode="decimal" />
                  <Button type="button" variant="outline" onClick={() => setItemDrafts((prev) => prev.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setItemDrafts((prev) => [...prev, { name: "Test notebook", quantity: "1", unitMajor: "10.00" }])}>Add item</Button>
                <Button type="button" disabled={busy === "items"} onClick={() => void saveItems()}>{busy === "items" ? "Saving…" : "Save items"}</Button>
                <Button type="button" variant="ghost" onClick={() => setEditingItems(false)}>Cancel</Button>
              </div>
              <p className="text-xs text-muted-foreground">Unit prices are entered in {currencyDraft} major units and converted with the currency exponent.</p>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={startItemEdit}>Edit items</Button>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            <Textarea aria-label="Order notes" value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={4} maxLength={2000} />
            <Button type="button" disabled={busy === "notes"} onClick={() => void saveNotes()}>{busy === "notes" ? "Saving…" : "Save notes"}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Fulfillment</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            <Field>
              <FieldLabel htmlFor="detail-fulfillment">Status</FieldLabel>
              <select id="detail-fulfillment" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={fulfillmentDraft} onChange={(e) => {
                const next = e.target.value;
                if (isFulfillment(next)) setFulfillmentDraft(next);
              }}>
                {FULFILLMENTS.map((f) => (<option key={f} value={f}>{statusLabel(f)}</option>))}
              </select>
            </Field>
            <Button type="button" disabled={busy === "fulfillment"} onClick={() => void saveFulfillment()}>{busy === "fulfillment" ? "Saving…" : "Save fulfillment"}</Button>
          </CardContent>
        </Card>
      </div>

      {detail.attempts.length === 0 ? (
        <Empty><EmptyHeader><EmptyTitle>No payment attempts</EmptyTitle><EmptyDescription>This order has no payment attempts yet.</EmptyDescription></EmptyHeader></Empty>
      ) : (
        detail.attempts.map((a) => {
          const readiness = readinessByGateway.get(a.gateway);
          const caps = readiness?.capabilities;
          const captureClosed = a.mode === "sandbox" && ["stripe", "paypal", "tap"].includes(a.gateway) && a.capturedMinor > 0;
          const captureOk = !captureClosed && !a.ambiguous && !a.pendingOperationId && captureStatusOk(a.status) && (caps?.authorization === true);
          const voidOk = !a.ambiguous && !a.pendingOperationId && voidStatusOk(a.status) && (caps?.voids === true);
          const refundOk = !a.ambiguous && !a.pendingOperationId && refundStatusOk(a.status) && (caps?.refunds === true);
          const showReconcile = needsReconcile(a);
          const captureRemaining = Math.max(a.amountMinor - a.capturedMinor, 0);
          const refundRemaining = Math.max(a.capturedMinor - a.refundedMinor, 0);
          return (
            <Card key={a.id}>
              <CardHeader><CardTitle className="text-base">Attempt {a.id}</CardTitle></CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge>{statusLabel(a.status)}</Badge>
                  <Badge variant="outline">{a.gateway}</Badge>
                  <Badge variant="outline">{a.mode}</Badge>
                  <Badge variant="outline">{a.captureIntent}</Badge>
                  {a.ambiguous && <Badge variant="destructive">Ambiguous</Badge>}
                  {a.pendingOperationId && <Badge variant="outline">Pending op</Badge>}
                </div>
                <p className="money">Amount {formatMinor(a.amountMinor, a.currency)} · Captured {formatMinor(a.capturedMinor, a.currency)} · Refunded {formatMinor(a.refundedMinor, a.currency)}</p>
                {readiness && caps && (
                  <p className="text-xs text-muted-foreground">
                    Capabilities: authorization {caps.authorization ? "yes" : "no"} · partial capture {caps.partialCapture ? "yes" : "no"} · voids {caps.voids ? "yes" : "no"} · refunds {caps.refunds ? "yes" : "no"} · partial refunds {caps.partialRefunds ? "yes" : "no"}
                  </p>
                )}
                <div className="grid gap-2 rounded-md border p-3">
                  <p className="font-medium">Capture / void / refund</p>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <Input aria-label={`Amount in ${a.currency} major units for attempt ${a.id}`} placeholder={`Amount in ${a.currency} (major units)`} value={amounts[a.id] ?? ""} onChange={(e) => setAmounts((prev) => ({ ...prev, [a.id]: e.target.value }))} inputMode="decimal" />
                    <Button type="button" disabled={!captureOk || busy !== null} onClick={() => void runAction(a, "capture", false)} title={!captureOk ? "Capture needs an authorized attempt and gateway authorization capability." : "Capture the entered amount"}>Capture</Button>
                    <Button type="button" variant="outline" disabled={!captureOk || busy !== null} onClick={() => void runAction(a, "capture", true)} title={!captureOk ? "Capture needs an authorized attempt and gateway authorization capability." : `Capture remaining ${formatMinor(captureRemaining, a.currency)}`}>Capture remaining</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" disabled={!voidOk || busy !== null} onClick={() => void runAction(a, "void", true)} title={!voidOk ? "Void needs an authorized attempt and gateway voids capability." : "Void the authorization"}>Void</Button>
                    <Button type="button" variant="outline" disabled={!refundOk || busy !== null} onClick={() => void runAction(a, "refund", false)} title={!refundOk ? "Refund needs a captured/paid attempt and gateway refunds capability." : `Refund entered amount (remaining ${formatMinor(refundRemaining, a.currency)})`}>Refund amount</Button>
                    <Button type="button" variant="outline" disabled={!refundOk || busy !== null} onClick={() => void runAction(a, "refund", true)} title={!refundOk ? "Refund needs a captured/paid attempt and gateway refunds capability." : "Refund remaining captured amount"}>Refund remaining</Button>
                    {showReconcile && (
                      <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void reconcile(a)}>Reconcile</Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Amounts are entered in {a.currency} major units and converted with exponent {exponentFor(a.currency)}. Remaining actions use the full available balance. The server validates status and capability.</p>
                </div>

                <SimulatorControls attempt={a} onChanged={refreshQuiet} />
                <div>
                  <p className="font-medium">Provider resources</p>
                  {Object.values(a.provider).every((v) => v === undefined) ? (
                    <p className="text-muted-foreground">No provider references yet.</p>
                  ) : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Value</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {Object.entries(a.provider).map(([k, v]) => (
                          <TableRow key={k}><TableCell>{k}</TableCell><TableCell>{typeof v === "string" ? v : "—"}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>

                <div>
                  <p className="font-medium">Operations</p>
                  {a.operations.length === 0 ? <p className="text-muted-foreground">No operations.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead>Amount</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {a.operations.map((o) => (
                          <TableRow key={o.id}><TableCell>{o.kind}</TableCell><TableCell><Badge variant="outline">{o.status}</Badge></TableCell><TableCell className="money">{formatMinor(o.amountMinor, o.currency)}</TableCell><TableCell>{o.updatedAt}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>

                <div>
                  <p className="font-medium">Refunds</p>
                  {a.refunds.length === 0 ? <p className="text-muted-foreground">No refunds.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Refund</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {a.refunds.map((r) => (
                          <TableRow key={r.id}><TableCell>{r.providerRefundId || r.id}</TableCell><TableCell className="money">{formatMinor(r.amountMinor, r.currency)}</TableCell><TableCell><Badge variant="outline">{r.status}</Badge></TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>

                <div>
                  <p className="font-medium">Webhook inbox</p>
                  {a.webhooks.length === 0 ? <p className="text-muted-foreground">No webhooks received.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Effect</TableHead><TableHead>Status</TableHead><TableHead>Received</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {a.webhooks.map((w) => (
                          <TableRow key={w.id}><TableCell>{w.providerEventId}</TableCell><TableCell>{w.effect}</TableCell><TableCell><Badge variant="outline">{w.status}</Badge></TableCell><TableCell>{w.createdAt}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>

                <div>
                  <p className="font-medium">Attempt audit</p>
                  {a.audit.length === 0 ? <p className="text-muted-foreground">No audit entries.</p> : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Detail</TableHead><TableHead>At</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {a.audit.map((e) => (
                          <TableRow key={e.id}><TableCell>{e.action}</TableCell><TableCell className="max-w-60 truncate">{e.detailJson}</TableCell><TableCell>{e.createdAt}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      <Card>
        <CardHeader><CardTitle>Order audit</CardTitle></CardHeader>
        <CardContent>
          {detail.audit.length === 0 ? <p className="text-sm text-muted-foreground">No audit entries.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Detail</TableHead><TableHead>At</TableHead></TableRow></TableHeader>
              <TableBody>
                {detail.audit.map((e) => (
                  <TableRow key={e.id}><TableCell>{e.action}</TableCell><TableCell className="max-w-60 truncate">{e.detailJson}</TableCell><TableCell>{e.createdAt}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
