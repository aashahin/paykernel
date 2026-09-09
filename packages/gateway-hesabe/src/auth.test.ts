import { describe, it, expect } from "bun:test";
import {
  AuthenticationError,
  NetworkError,
  PaymentAbortedError,
  RateLimitError,
  type Clock,
} from "@paykernel/core";
import { HesabeAuth, parseHesabeAuthEnvelope } from "./auth";

const BASE = "https://merchant.test";
const USER = "merchant-user";
const PASS = "merchant-pass";

function makeClock(startMs = 1_000_000): {
  clock: Clock;
  advance: (ms: number) => void;
} {
  let now = startMs;
  return {
    clock: {
      now: () => new Date(now),
      nowMs: () => now,
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function successBody(access: string, refresh: string, expiresIn = 900): unknown {
  return {
    status: true,
    response: {
      token: {
        token_type: "Bearer",
        expires_in: expiresIn,
        access_token: access,
        refresh_token: refresh,
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function depsFor(
  fetchImpl: typeof globalThis.fetch,
  clock: Clock,
  timeoutMs = 1_000,
): {
  fetch: typeof globalThis.fetch;
  clock: Clock;
  merchantBaseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
} {
  return {
    fetch: fetchImpl,
    clock,
    merchantBaseUrl: BASE,
    username: USER,
    password: PASS,
    timeoutMs,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("parseHesabeAuthEnvelope", () => {
  it("accepts the exact success envelope", () => {
    const snap = parseHesabeAuthEnvelope(successBody("a", "r", 900), 1_000);
    expect(snap.accessToken).toBe("a");
    expect(snap.refreshToken).toBe("r");
    expect(snap.expiresAt).toBe(1_000 + 900_000);
  });

  it("rejects explicit status:false as AuthenticationError", () => {
    expect(() => parseHesabeAuthEnvelope({ status: false, message: "bad" }, 0)).toThrow(
      AuthenticationError,
    );
  });

  it("rejects wrong token_type as protocol NetworkError", () => {
    const body = {
      status: true,
      response: {
        token: {
          token_type: "bearer",
          expires_in: 900,
          access_token: "a",
          refresh_token: "r",
        },
      },
    };
    expect(() => parseHesabeAuthEnvelope(body, 0)).toThrow(NetworkError);
  });

  it.each([
    { name: "zero", expiresIn: 0 },
    { name: "negative", expiresIn: -5 },
    { name: "NaN", expiresIn: Number.NaN },
    { name: "Infinity", expiresIn: Number.POSITIVE_INFINITY },
    { name: "string", expiresIn: "900" },
    { name: "missing", expiresIn: undefined },
  ])("rejects invalid expires_in $name as NetworkError", ({ expiresIn }) => {
    const body = {
      status: true,
      response: {
        token: {
          token_type: "Bearer",
          expires_in: expiresIn,
          access_token: "a",
          refresh_token: "r",
        },
      },
    };
    expect(() => parseHesabeAuthEnvelope(body, 0)).toThrow(NetworkError);
  });

  it.each([
    { name: "blank access token", access: "   ", refresh: "r" },
    { name: "empty refresh token", access: "a", refresh: "" },
  ])("rejects $name as NetworkError", ({ access, refresh }) => {
    expect(() => parseHesabeAuthEnvelope(successBody(access, refresh), 0)).toThrow(NetworkError);
  });
});

describe("HesabeAuth login/refresh", () => {
  it("posts login with username/password and caches the token", async () => {
    const { clock } = makeClock();
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      const request = init as { body?: string };
      seen.push({
        url: String(url),
        body: JSON.parse(String(request.body ?? "{}")) as unknown,
      });
      return jsonResponse(successBody("access-1", "refresh-1"));
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const first = await auth.getAccessToken();
    const second = await auth.getAccessToken();
    expect(first).toBe("access-1");
    expect(second).toBe("access-1");
    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe(`${BASE}/api/v1/login`);
    expect(seen[0]?.body).toEqual({ username: USER, password: PASS });
  });

  it("refreshes 60s early using the fake clock", async () => {
    const fake = makeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(successBody(`access-${calls}`, `refresh-${calls}`, 900));
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, fake.clock));
    await auth.getAccessToken();
    expect(calls).toBe(1);
    // 900s - 61s still fresh.
    fake.advance((900 - 61) * 1_000);
    await auth.getAccessToken();
    expect(calls).toBe(1);
    // Inside the 60s early window a refresh is attempted (refreshToken path).
    fake.advance(2_000);
    const token = await auth.getAccessToken();
    expect(calls).toBe(2);
    expect(token).toBe("access-2");
  });

  it("shares one concurrent login across callers", async () => {
    const { clock } = makeClock();
    let calls = 0;
    const gate = deferred<Response>();
    // Attach a late noop handler so the test harness never reports an
    // unhandled rejection for the deferred gate itself.
    gate.promise.catch(() => undefined);
    const fetchImpl = (async () => {
      calls += 1;
      return gate.promise;
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    void first.then(undefined, () => undefined);
    void second.then(undefined, () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    gate.resolve(jsonResponse(successBody("shared", "refresh-shared")));
    await expect(first).resolves.toBe("shared");
    await expect(second).resolves.toBe("shared");
    expect(calls).toBe(1);
  });

  it("a pre-aborted caller starts no fetch", async () => {
    const { clock } = makeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(successBody("a", "r"));
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const controller = new AbortController();
    controller.abort();
    await expect(auth.getAccessToken(controller.signal)).rejects.toBeInstanceOf(
      PaymentAbortedError,
    );
    expect(calls).toBe(0);
  });

  it("an aborted waiter does not poison the shared login for others", async () => {
    const { clock } = makeClock();
    const gate = deferred<Response>();
    gate.promise.catch(() => undefined);
    const fetchImpl = (async () => gate.promise) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const aborter = new AbortController();
    const abortedCall = auth.getAccessToken(aborter.signal);
    const survivorCall = auth.getAccessToken();
    void abortedCall.then(undefined, () => undefined);
    void survivorCall.then(undefined, () => undefined);
    aborter.abort();
    await expect(abortedCall).rejects.toBeInstanceOf(PaymentAbortedError);
    gate.resolve(jsonResponse(successBody("survivor", "refresh-survivor")));
    await expect(survivorCall).resolves.toBe("survivor");
    // Survivor populates the cache; later callers are served without fetch.
    await expect(auth.getAccessToken()).resolves.toBe("survivor");
  });

  it("all-cancel leaves no poison: the next call still logs in", async () => {
    const { clock } = makeClock();
    const gate = deferred<Response>();
    gate.promise.catch(() => undefined);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return gate.promise;
      return jsonResponse(successBody("second", "refresh-second"));
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = auth.getAccessToken(firstController.signal);
    const second = auth.getAccessToken(secondController.signal);
    void first.then(undefined, () => undefined);
    void second.then(undefined, () => undefined);
    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toBeInstanceOf(PaymentAbortedError);
    await expect(second).rejects.toBeInstanceOf(PaymentAbortedError);
    // Late shared failure must not surface as an unhandled rejection and
    // must clear singleflight state.
    gate.reject(new Error("connection dropped after all callers cancelled"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(auth.getAccessToken()).resolves.toBe("second");
  });

  it.each([
    { name: "401 HTML body", status: 401, text: "<html>unauthorized</html>" },
    { name: "403 empty body", status: 403, text: "" },
  ])("refresh $name falls back to login", async ({ status, text }) => {
    const fake = makeClock();
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/v1/login")) {
        return jsonResponse(
          successBody(urls.length === 1 ? "old" : "fresh", `refresh-${urls.length}`),
        );
      }
      return text === "" ? new Response("", { status }) : htmlResponse(text, status);
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, fake.clock));
    await auth.getAccessToken();
    fake.advance(900_000);
    const token = await auth.getAccessToken();
    expect(token).toBe("fresh");
    expect(urls).toEqual([
      `${BASE}/api/v1/login`,
      `${BASE}/api/v1/token-refresh`,
      `${BASE}/api/v1/login`,
    ]);
  });

  it.each([
    {
      name: "429 rate-limited",
      status: 429,
      text: JSON.stringify({ status: false }),
      html: false,
      expectedError: RateLimitError,
    },
    {
      name: "500 server HTML",
      status: 500,
      text: "<html>oops</html>",
      html: true,
      expectedError: NetworkError,
    },
  ])("refresh $name never falls back to login", async ({ status, text, html, expectedError }) => {
    const fake = makeClock();
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/v1/login")) {
        return jsonResponse(successBody("old", "old-refresh"));
      }
      return html ? htmlResponse(text, status) : new Response(text, { status });
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, fake.clock));
    await auth.getAccessToken();
    fake.advance(900_000);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(expectedError);
    expect(urls).toEqual([`${BASE}/api/v1/login`, `${BASE}/api/v1/token-refresh`]);
  });

  it("HTTP 200 status:false is an explicit AuthenticationError", async () => {
    const { clock } = makeClock();
    const fetchImpl = (async () =>
      jsonResponse({ status: false, message: "bad credentials" })) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("HTTP 200 malformed success envelope is a protocol NetworkError", async () => {
    const { clock } = makeClock();
    const fetchImpl = (async () =>
      jsonResponse({
        status: true,
        response: { token: { token_type: "Bearer" } },
      })) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
  });

  it.each([
    { name: "empty body", text: "", status: 200, html: false },
    { name: "HTML body", text: "<html></html>", status: 200, html: true },
  ])("HTTP 200 $name is an invalid JSON NetworkError", async ({ text, status, html }) => {
    const { clock } = makeClock();
    const fetchImpl = (async () =>
      html
        ? htmlResponse(text, status)
        : new Response(text, { status })) as typeof globalThis.fetch;
    await expect(new HesabeAuth(depsFor(fetchImpl, clock)).getAccessToken()).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("does not leak credentials or raw bodies in errors", async () => {
    const { clock } = makeClock();
    const secretBody = JSON.stringify({
      status: false,
      echo: `${USER}:${PASS}:supersecret`,
    });
    const fetchImpl = (async () =>
      new Response(secretBody, { status: 200 })) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock));
    const error = await auth.getAccessToken().then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(String(error?.message)).not.toContain(USER);
    expect(String(error?.message)).not.toContain(PASS);
    expect(JSON.stringify(error)).not.toContain("supersecret");
  });

  it("timeout covers a hanging fetch", async () => {
    const { clock } = makeClock();
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock, 30));
    const error = await auth.getAccessToken().then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error?.message)).toContain("timed out");
  });

  it("timeout covers a hanging response body that respects the abort signal", async () => {
    const { clock } = makeClock();
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const hangingText = () =>
        new Promise<string>((_, reject) => {
          if (signal?.aborted === true) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      return {
        ok: true,
        status: 200,
        text: hangingText,
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const auth = new HesabeAuth(depsFor(fetchImpl, clock, 30));
    const error = await auth.getAccessToken().then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error?.message)).toContain("timed out");
  });
});

it("observes a shared login failure when fetch synchronously cancels its only caller", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { clock } = makeClock();
  const fetchImpl = (async () => {
    if (++calls === 1) {
      controller.abort();
      throw new Error("transport failed during caller cancellation");
    }
    return jsonResponse(successBody("recovered", "refresh-recovered"));
  }) as typeof fetch;
  const auth = new HesabeAuth(depsFor(fetchImpl, clock));
  await expect(auth.getAccessToken(controller.signal)).rejects.toBeInstanceOf(PaymentAbortedError);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(auth.getAccessToken()).resolves.toBe("recovered");
});

it("auth timeout settles when injected fetch ignores AbortSignal", async () => {
  const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch;
  const auth = new HesabeAuth(depsFor(fetchImpl, makeClock().clock, 20));
  await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
}, 500);
