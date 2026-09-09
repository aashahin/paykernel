import {
  AuthenticationError,
  createTimeoutSignal,
  mapHttpAbortError,
  NetworkError,
  PaymentAbortedError,
  RateLimitError,
  type Clock,
} from "@paykernel/core";

import { abortError, awaitWithAbort } from "./abort";

type HesabeAuthSnapshot = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Validate the exact merchant login / token-refresh envelope:
 * `{status: true, response: {token: {token_type: "Bearer", expires_in, access_token, refresh_token}}}`.
 * `status` must be boolean `true` (not truthy). No credential bodies in errors.
 *
 * An explicit `status: false` envelope is a credential rejection
 * ({@link AuthenticationError}). A `status: true` envelope with a malformed
 * token section is a protocol error ({@link NetworkError}) — never a
 * credential rejection, so refresh never falls back to login for it.
 */
export function parseHesabeAuthEnvelope(body: unknown, nowMs: number): HesabeAuthSnapshot {
  const root = asRecord(body);
  if (root.status === false) {
    throw new AuthenticationError("Hesabe merchant login failed");
  }
  if (root.status !== true) {
    throw new NetworkError("Hesabe merchant auth returned an invalid response");
  }
  const token = asRecord(asRecord(root.response).token);
  if (token.token_type !== "Bearer") {
    throw new NetworkError("Hesabe merchant auth returned an invalid response");
  }
  const expiresIn = token.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new NetworkError("Hesabe merchant auth returned an invalid response");
  }
  const accessToken = token.access_token;
  const refreshToken = token.refresh_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new NetworkError("Hesabe merchant auth returned an invalid response");
  }
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new NetworkError("Hesabe merchant auth returned an invalid response");
  }
  if (!Number.isFinite(nowMs + expiresIn * 1000)) {
    throw new NetworkError("Hesabe merchant auth returned an invalid expiry");
  }
  return {
    accessToken: accessToken.trim(),
    refreshToken: refreshToken.trim(),
    expiresAt: nowMs + Math.floor(expiresIn * 1000),
  };
}

export type HesabeAuthDeps = {
  fetch: typeof globalThis.fetch;
  clock: Clock;
  merchantBaseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
};

/**
 * Per-instance lazy singleflight merchant auth.
 *
 * Expiry is `clock.nowMs() + expires_in*1000`, refreshed 60s early. The
 * shared fetch uses only the timeout signal: a caller pre-abort never starts
 * a fetch, and one caller abort never cancels another caller's auth. Only an
 * explicit `AuthenticationError` falls back from refresh to login once;
 * network / timeout / 429 failures propagate.
 */
export class HesabeAuth {
  private snapshot: HesabeAuthSnapshot | undefined;
  private inFlight: Promise<HesabeAuthSnapshot> | undefined;

  constructor(private readonly deps: HesabeAuthDeps) {}

  async getAccessToken(callerSignal?: AbortSignal): Promise<string> {
    if (callerSignal?.aborted === true) {
      throw new PaymentAbortedError("Hesabe auth aborted by caller signal");
    }
    const cached = this.snapshot;
    if (cached !== undefined && this.isFresh(cached)) {
      return cached.accessToken;
    }
    const shared = this.startSharedAuth();
    return this.awaitShared(shared, callerSignal);
  }

  private isFresh(snapshot: HesabeAuthSnapshot): boolean {
    return this.deps.clock.nowMs() < snapshot.expiresAt - 60_000;
  }

  private startSharedAuth(): Promise<HesabeAuthSnapshot> {
    if (this.inFlight === undefined) {
      this.inFlight = this.refreshOrLogin().then(
        (snapshot) => {
          this.snapshot = snapshot;
          this.inFlight = undefined;
          return snapshot;
        },
        (error) => {
          this.inFlight = undefined;
          throw error;
        },
      );
    }
    return this.inFlight;
  }

  private async awaitShared(
    shared: Promise<HesabeAuthSnapshot>,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const tokenSnapshot = await awaitWithAbort(
      shared,
      callerSignal,
      () => new PaymentAbortedError("Hesabe auth aborted by caller signal"),
    );
    return tokenSnapshot.accessToken;
  }

  private async refreshOrLogin(): Promise<HesabeAuthSnapshot> {
    const existing = this.snapshot;
    if (existing !== undefined && existing.refreshToken.length > 0) {
      try {
        return await this.postAuth("/api/v1/token-refresh", {
          refreshToken: existing.refreshToken,
        });
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
      }
    }
    return this.postAuth("/api/v1/login", {
      username: this.deps.username,
      password: this.deps.password,
    });
  }

  private async postAuth(path: string, body: Record<string, unknown>): Promise<HesabeAuthSnapshot> {
    const { signal: timeoutSignal, clear } = createTimeoutSignal(this.deps.timeoutMs);
    // Intentionally timeout-only: caller signals race in awaitShared and
    // never cancel the shared provider fetch.
    try {
      let response: Response;
      try {
        response = await awaitWithAbort(
          this.deps.fetch(`${this.deps.merchantBaseUrl}${path}`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: timeoutSignal,
            redirect: "error",
          }),
          timeoutSignal,
        );
      } catch (error) {
        throw mapHttpAbortError(
          timeoutSignal.aborted ? abortError() : new Error("Hesabe auth transport failed"),
          {
            timeoutSignal,
            timeoutMessage: `Hesabe merchant auth timed out after ${this.deps.timeoutMs}ms`,
            networkMessage: "Failed to reach Hesabe merchant API",
          },
        );
      }
      let responseText: string;
      try {
        responseText = await awaitWithAbort(response.text(), timeoutSignal);
      } catch (error) {
        throw mapHttpAbortError(
          timeoutSignal.aborted ? abortError() : new Error("Hesabe auth body failed"),
          {
            timeoutSignal,
            timeoutMessage: `Hesabe merchant auth timed out after ${this.deps.timeoutMs}ms`,
            networkMessage: "Failed to reach Hesabe merchant API",
          },
        );
      }
      // HTTP classification before body JSON parse: an explicit 401/403
      // rejection triggers the refresh→login fallback even when the body is
      // HTML or empty. 429 / 5xx never fall back.
      if (!response.ok) {
        if (response.status === 429) {
          throw new RateLimitError("hesabe");
        }
        if (response.status >= 500) {
          throw new NetworkError(`Hesabe merchant auth error (${response.status})`, {
            status: response.status,
          });
        }
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError("Hesabe merchant login failed");
        }
        throw new NetworkError(`Hesabe merchant auth error (${response.status})`);
      }
      if (responseText.trim().length === 0) {
        throw new NetworkError("Hesabe merchant auth returned invalid JSON", {
          status: response.status,
        });
      }
      let data: unknown;
      try {
        data = JSON.parse(responseText) as unknown;
      } catch (error) {
        if (error instanceof Error) {
          throw new NetworkError("Hesabe merchant auth returned invalid JSON", {
            status: response.status,
          });
        }
        throw error;
      }
      // parseHesabeAuthEnvelope already throws AuthenticationError for an
      // explicit status:false rejection and NetworkError for a malformed
      // status:true envelope — no broad catch here.
      return parseHesabeAuthEnvelope(data, this.deps.clock.nowMs());
    } finally {
      clear();
    }
  }
}
