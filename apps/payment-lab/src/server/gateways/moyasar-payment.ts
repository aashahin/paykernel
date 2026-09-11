import { fromMinorUnits, type GatewayPaymentResult } from "@paykernel/core";
import { z } from "zod";

const saleSchema = z.object({
  id: z.string().min(1), status: z.enum(["paid", "refunded"]),
  amount: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/),
  captured: z.literal(0), captured_at: z.null(), refunded: z.number().int().nonnegative(),
});

/** Authenticated Moyasar sales use `paid`; `captured` tracks manual captures. */
export function normalizeMoyasarSale(result: GatewayPaymentResult): GatewayPaymentResult {
  const parsed = saleSchema.safeParse(result.rawResponse);
  if (!parsed.success || result.reconciliationRequired || result.outcome === "indeterminate") return result;
  const sale = parsed.data;
  if (sale.id !== result.gatewayId || sale.refunded > sale.amount || (sale.status === "refunded" && sale.refunded === 0)) return result;
  const status = sale.refunded === 0 ? "paid" : sale.refunded === sale.amount ? "refunded" : "partially_refunded";
  return { ...result, status, outcome: "succeeded", capturedAmount: fromMinorUnits(sale.amount, sale.currency),
    ...(result.references ? { references: { ...result.references, normalizedStatus: status } } : {}),
  };
}
