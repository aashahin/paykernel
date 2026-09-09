import {
  createTimeoutSignal,
  mapHttpAbortError,
  PaymentAbortedError,
  DEFAULT_RETRY_CONFIG,
  RateLimitError,
} from "@paykernel/core";
import { abortError, awaitWithAbort, waitForRetry } from "./abort";
import { isHesabeRetryableError, mapHesabeHttpFailure } from "./http";

export type HesabeRequestInput = {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  onSubmit?: () => void;
};

/** Core withRetry has no cancellation during backoff; keep its defaults here
 * until it supports AbortSignal, while cancelling both the wait and request. */
export async function hesabeReadRequest(
  input: Omit<HesabeRequestInput, "method" | "onSubmit" | "body">,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await hesabeRequest({ ...input, method: "GET" });
    } catch (error) {
      if (input.signal?.aborted)
        throw new PaymentAbortedError("Hesabe read aborted by caller signal");
      if (!isHesabeRetryableError(error) || attempt + 1 >= DEFAULT_RETRY_CONFIG.maxAttempts)
        throw error;
      try {
        await waitForRetry(readRetryDelay(error, attempt), input.signal);
      } catch {
        throw new PaymentAbortedError("Hesabe read aborted by caller signal");
      }
    }
  }
}

function readRetryDelay(error: unknown, attempt: number): number {
  const retryAfter = error instanceof RateLimitError ? error.retryAfterSeconds : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter * 1000, 120_000);
  const cap = Math.min(
    DEFAULT_RETRY_CONFIG.baseDelayMs * 2 ** attempt,
    DEFAULT_RETRY_CONFIG.maxDelayMs,
  );
  return Math.floor(Math.random() * (cap + 1));
}

/**
 * Portable Hesabe HTTP transport. Single attempt — never retries. The caller
 * owns encryption, JSON parsing, and retry policy.
 *
 * POST is treated as a potential provider submit: fetch / body aborts map to
 * `NetworkError` tagged `afterProviderSubmit` (ambiguous — the parent gateway
 * maps this to indeterminate). A caller abort detected before `fetch` is a
 * clean `PaymentAbortedError` with no submit.
 */
export async function hesabeRequest(input: HesabeRequestInput): Promise<string> {
  if (input.signal?.aborted === true) {
    throw new PaymentAbortedError("Hesabe API request aborted by caller signal");
  }
  const { signal: timeoutSignal, clear } = createTimeoutSignal(input.timeoutMs);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  timeoutSignal.addEventListener("abort", forwardAbort, { once: true });
  if (input.signal?.aborted || timeoutSignal.aborted) forwardAbort();
  const combined = controller.signal;
  try {
    if (combined.aborted === true) {
      throw new PaymentAbortedError("Hesabe API request aborted by caller signal");
    }
    const isPost = input.method === "POST";
    const abortOptions = {
      callerSignal: input.signal,
      timeoutSignal,
      timeoutMessage: `Hesabe API request timed out after ${input.timeoutMs}ms`,
      networkMessage: "Failed to reach Hesabe API",
      callerAbortMessage: "Hesabe API request aborted by caller signal",
      afterProviderSubmit: isPost ? true : undefined,
    };
    if (isPost) input.onSubmit?.();
    let response: Response;
    try {
      response = await awaitWithAbort(
        input.fetch(input.url, {
          method: input.method,
          headers: input.headers,
          ...(input.body !== undefined ? { body: input.body } : {}),
          signal: combined,
          redirect: "error",
        }),
        combined,
      );
    } catch {
      throw mapHttpAbortError(
        combined.aborted ? abortError() : new Error("Hesabe transport failed"),
        abortOptions,
      );
    }
    let responseText: string;
    try {
      responseText = await awaitWithAbort(response.text(), combined);
    } catch {
      throw mapHttpAbortError(
        combined.aborted ? abortError() : new Error("Hesabe response body failed"),
        abortOptions,
      );
    }
    if (!response.ok) {
      throw mapHesabeHttpFailure({
        status: response.status,
        headers: response.headers,
        postSubmit: isPost,
      });
    }
    return responseText;
  } finally {
    clear();
    input.signal?.removeEventListener("abort", forwardAbort);
    timeoutSignal.removeEventListener("abort", forwardAbort);
  }
}
