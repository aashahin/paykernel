import type { AppEnv } from "../env";
import { getOrder } from "./payments/orders";
import { listAttemptsByOrder } from "./payments/attempts";
import { listOperationsByAttempt } from "./payments/operations";
import { listRefundsByAttempt } from "./payments/evidence";
import { listWebhooksByAttempt } from "./payments/inbox";
import { listAuditByEntity } from "./payments/testing";

export { startPayment } from "./start-payment";
export { performPaymentAction, reconcileAttempt } from "./payment-actions";

export async function getOrderDetail(env: AppEnv, orderId: string) {
  const storedOrder = await getOrder(env.DB, orderId);
  const { guestTokenHash: _guestTokenHash, ...order } = storedOrder;
  const storedAttempts = await listAttemptsByOrder(env.DB, orderId);
  const attempts = await Promise.all(storedAttempts.map(async (storedAttempt) => {
    const { fingerprint: _fingerprint, ...attempt } = storedAttempt;
    const [operations, refunds, webhooks, audit] = await Promise.all([
      listOperationsByAttempt(env.DB, attempt.id),
      listRefundsByAttempt(env.DB, attempt.id),
      listWebhooksByAttempt(env.DB, attempt.id),
      listAuditByEntity(env.DB, "attempt", attempt.id),
    ]);
    return { ...attempt, operations, refunds, webhooks, audit };
  }));
  return { order, attempts, audit: await listAuditByEntity(env.DB, "order", orderId) };
}

export type OrderDetail = Awaited<ReturnType<typeof getOrderDetail>>;
