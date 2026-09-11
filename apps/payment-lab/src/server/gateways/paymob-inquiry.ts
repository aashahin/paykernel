import { createDefaultGatewayContext, InvalidRequestError, paymobGateway } from "@paykernel/core";
import { z } from "zod";

const idSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String);
const transactionSchema = z.object({
  id: idSchema, is_live: z.boolean().optional(), success: z.boolean().optional(), pending: z.boolean().optional(),
  is_auth: z.boolean().optional(), is_capture: z.boolean().optional(), is_standalone_payment: z.boolean().optional(),
  amount_cents: z.number().int().positive().optional(),
  order: z.object({ id: idSchema, merchant_order_id: z.string().nullable().optional(),
    paid_amount_cents: z.number().int().nonnegative().optional() }).optional(),
});

/** Transaction inquiry uses legacy Bearer auth; Intention creation uses the modern secret. */
export function createPaymobInquiry(apiKey: string) {
  const gateway = paymobGateway({ region: "eg", apiKey }).create(createDefaultGatewayContext());
  async function lookup(id: string) {
    const result = await gateway.getPayment({ gatewayPaymentId: id });
    const wrapped = z.object({ obj: z.unknown() }).safeParse(result.rawResponse);
    const transaction = transactionSchema.parse(wrapped.success ? wrapped.data.obj : result.rawResponse);
    if (transaction.is_live === true) throw new InvalidRequestError("Live Paymob transactions are disabled.");
    const reference = transaction.order?.merchant_order_id;
    // A standalone sale can have captured_amount=0: that field describes a separate capture.
    // Require authenticated, fully paid order evidence before using the sale amount.
    const paidSale = ["paid", "partially_refunded", "refunded"].includes(result.status) && transaction.success === true && transaction.pending === false
      && transaction.is_standalone_payment === true && transaction.is_auth === false && transaction.is_capture === false
      && transaction.amount_cents !== undefined && transaction.order?.paid_amount_cents === transaction.amount_cents;
    return { ...result,
      ...(paidSale && result.amount ? { capturedAmount: result.amount } : {}),
      ...(transaction.order ? { orderId: transaction.order.id } : {}),
      references: { ...result.references, gateway: "paymob", providerObjectId: result.gatewayId,
        normalizedStatus: result.status, ...(reference ? { internalReference: reference } : {}),
        relatedIds: { ...result.references?.relatedIds, transactionId: transaction.id,
          ...(transaction.order ? { orderId: transaction.order.id } : {}) } },
    };
  }
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`https://accept.paymob.com${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new InvalidRequestError(`Paymob reference inquiry failed (${response.status}).`);
    return response.json();
  }
  async function lookupByReference(reference: string) {
    const auth = z.object({ token: z.string().min(1) }).parse(await post("/api/auth/tokens", { api_key: apiKey }));
    const transaction = transactionSchema.parse(await post("/api/ecommerce/orders/transaction_inquiry", {
      auth_token: auth.token, merchant_order_id: reference,
    }));
    if (transaction.order?.merchant_order_id !== reference) throw new InvalidRequestError("Paymob reference mismatch.");
    const result = await lookup(transaction.id);
    if (result.references.internalReference !== reference) throw new InvalidRequestError("Paymob reference mismatch.");
    return result;
  }
  return { lookup, lookupByReference };
}
