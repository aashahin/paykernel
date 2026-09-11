"use client";

import { useEffect, useMemo, useState } from "react";
import { createApiClient } from "../lib/api-client";
import { formatMinor, statusLabel } from "../lib/format";
import type { SanitizedAttempt, SanitizedOrder } from "../server/lab-api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
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

type Summary = { order: SanitizedOrder; latestAttempt: SanitizedAttempt | null };

async function errorMessage(res: { status: number; text(): Promise<string> }, fallback: string): Promise<string> {
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

export default function SellerOrders() {
  const [client] = useState(() => createApiClient("/"));
  const [orders, setOrders] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.api.seller.orders.$get();
        if (!res.ok) throw new Error(await errorMessage(res, "Failed to load orders"));
        const data = await res.json();
        if (live) setOrders(data.orders);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Failed to load orders.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);

  const statuses = useMemo(() => {
    const seen = new Set<string>();
    for (const s of orders) {
      if (s.latestAttempt) seen.add(s.latestAttempt.status);
    }
    return [...seen].sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((s) => {
      if (status !== "all") {
        const st = s.latestAttempt ? s.latestAttempt.status : "no_attempt";
        if (st !== status) return false;
      }
      if (!q) return true;
      const hay = [
        s.order.id,
        s.order.customerName,
        s.order.customerEmail,
        s.latestAttempt ? s.latestAttempt.gateway : "",
        s.latestAttempt ? s.latestAttempt.status : "no attempt",
        s.latestAttempt ? s.latestAttempt.mode : "",
        s.order.currency,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orders, query, status]);

  if (loading) {
    return (
      <div className="grid gap-3" aria-label="Loading seller orders">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_220px]">
          <Field>
            <FieldLabel htmlFor="seller-search">Search orders</FieldLabel>
            <Input
              id="seller-search"
              placeholder="Order id, customer, gateway…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="seller-status">Status</FieldLabel>
            <select
              id="seller-status"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="no_attempt">No attempt</option>
              {statuses.map((st) => (
                <option key={st} value={st}>
                  {statusLabel(st)}
                </option>
              ))}
            </select>
          </Field>
        </CardContent>
      </Card>

      {orders.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No orders yet</EmptyTitle>
            <EmptyDescription>Create a test checkout to start exploring payment workflows.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No matching orders</EmptyTitle>
            <EmptyDescription>Adjust the search or status filter.</EmptyDescription>
          </EmptyHeader>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setQuery("");
              setStatus("all");
            }}
          >
            Clear filters
          </Button>
        </Empty>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Gateway</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow key={s.order.id}>
                    <TableCell>
                      <a className="underline underline-offset-4" href={`/seller/orders/${s.order.id}`}>
                        {s.order.id.slice(0, 12)}…
                      </a>
                    </TableCell>
                    <TableCell>
                      <span className="block font-medium">{s.order.customerName}</span>
                      <span className="block text-xs text-muted-foreground">{s.order.customerEmail}</span>
                    </TableCell>
                    <TableCell className="money">
                      {formatMinor(s.order.totalMinor, s.order.currency)}
                    </TableCell>
                    <TableCell>
                      {s.latestAttempt ? (
                        <Badge variant="secondary">{statusLabel(s.latestAttempt.status)}</Badge>
                      ) : (
                        <Badge variant="outline">No attempt</Badge>
                      )}
                    </TableCell>
                    <TableCell>{s.latestAttempt ? s.latestAttempt.mode : "—"}</TableCell>
                    <TableCell>{s.latestAttempt ? s.latestAttempt.gateway : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              Showing {filtered.length} of {orders.length} orders.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
