/**
 * @paykernel/webhooks — portable webhook inbox engine.
 *
 * Depends only on `@paykernel/core` (core). No testkit, adapters, or Redis.
 * No framework HTTP status hardcoding. No Node-only imports.
 *
 * @packageDocumentation
 */

// Engine
export {
  createWebhookInboxEngine,
  computePayloadHash,
  resolveInboxPayloadHash,
} from "./engine";
export type { ResolveInboxPayloadHashInput } from "./engine";

// Event key
export {
  deriveWebhookEventKey,
  parseWebhookEventKey,
  qualifyPaymobProviderEventId,
} from "./event-key";

// Sanitize
export {
  sanitizeWebhookError,
  redactOpaquePayloadRefString,
  DEFAULT_SANITIZE_MAX_LENGTH,
} from "./sanitize";
export type { SanitizeWebhookErrorOptions } from "./sanitize";

// Store contract + errors
export {
  StoreLeaseLostError,
  isStoreLeaseLostError,
} from "./store";
export type {
  WebhookEventKey,
  LeaseToken,
  IsoTimestamp,
  CleanupInput,
  CleanupResult,
  WithTransaction,
  WebhookInboxStatus,
  WebhookInboxRecord,
  ClaimWebhookInput,
  ClaimWebhookResult,
  RenewWebhookLeaseInput,
  RenewWebhookLeaseResult,
  CompleteWebhookInput,
  FailWebhookInput,
  ListRetryableInput,
  WebhookInboxStore,
} from "./store";

// Types / modes / outcomes
export { NonRetryableHandlerError } from "./types";
export type {
  WebhookProcessingMode,
  WebhookProcessingOutcome,
  ScheduledForRetryReason,
  EngineClock,
  WebhookHandlerContext,
  WebhookHandler,
  ProcessVerifiedInput,
  VerifyAndNormalizeResult,
  VerifyAndNormalize,
  ProcessWithVerifierInput,
  ProcessRetryableInput,
  ProcessOneInput,
  ProcessOneResult,
  ProcessRetryableItemResult,
  ProcessRetryableResult,
  SanitizeErrorFn,
  CreateWebhookInboxEngineOptions,
  WebhookInboxEngine,
} from "./types";

// Test-only memory store is NOT exported from the public surface intentionally.
// Import from source in package tests only; durable adapters live in Phase 11+.
// Dual with testkit createMemoryWebhookInboxStore (also NON-PRODUCTION); can drift —
// apps must use production @paykernel/store-* adapters, never these memory stores.
