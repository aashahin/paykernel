import { createReconciliationScheduler } from "@paykernel/reconciliation";
import type { AppEnv } from "../env";
import { getAttempt } from "./payments/attempts";
import { reconcileAttempt } from "./payment-actions";
import { createSdkStores } from "./sdk-stores";
import { retryWebhooks } from "./webhook-service";

export async function runScheduled(env: AppEnv) {
  const webhooks = await retryWebhooks(env);
  const scheduler = createReconciliationScheduler({ store: createSdkStores(env.DB).reconciliation, owner: "payment-lab-cron" });
  const { results } = await env.DB.prepare(`SELECT id FROM lab_attempts WHERE (ambiguous = 1 OR status IN ('pending','processing','approved')) AND NOT EXISTS (SELECT 1 FROM payment_reconciliation_jobs WHERE key = 'lab:' || lab_attempts.mode || ':' || lab_attempts.id || ':' || COALESCE(lab_attempts.pending_operation_id,'payment')) ORDER BY updated_at ASC LIMIT 20`).all<{ id: string }>();
  for (const row of results) {
    const attempt = await getAttempt(env.DB, row.id);
    await scheduler.schedule({ key: `lab:${attempt.mode}:${attempt.id}:${attempt.pendingOperationId ?? "payment"}`, target: { gateway: attempt.gateway, localReference: attempt.id }, runAt: new Date().toISOString(), reason: "unsettled_payment" });
  }
  const reconciliation = await scheduler.processDue({ limit: 20, handler: async job => {
    const result = await reconcileAttempt(env, job.record.subjectId);
    const attempt = result.attempt;
    if (attempt.ambiguous || ["pending", "processing", "approved"].includes(attempt.status)) return { disposition: "retry_later", retryAfterMs: 60_000 };
    return { disposition: "complete" };
  } });
  return { webhooks, reconciliation };
}
