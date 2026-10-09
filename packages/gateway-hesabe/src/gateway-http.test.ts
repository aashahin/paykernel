import { describe, it, expect } from "bun:test";
import {
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  PaymentAbortedError,
  RateLimitError,
  ResourceNotFoundError,
} from "@paykernel/core";
import { createFetchStub } from "../test-utils/fetch";
import { hesabeRequest } from "./gateway-http";

const URL = "https://merchant.test/api/v1/checkout";
const HEADERS = { accessCode: "ac", "Content-Type": "application/json" };

function okResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function statusResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function abortReject(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    if (signal?.aborted === true) {
      reject(err);
      return;
    }
    signal?.addEventListener("abort", () => reject(err), { once: true });
  });
}

describe("hesabeRequest", () => {
  it("pre-aborted POST starts no fetch and skips onSubmit", async () => {
    let calls = 0;
    let submitted = 0;
    const fetchImpl = createFetchStub(async () => {
      calls += 1;
      return okResponse("deadbeef");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      hesabeRequest({
        fetch: fetchImpl,
        timeoutMs: 1_000,
        url: URL,
        method: "POST",
        headers: HEADERS,
        body: "{}",
        signal: controller.signal,
        onSubmit: () => {
          submitted += 1;
        },
      }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toBe(0);
    expect(submitted).toBe(0);
  });

  it("pre-aborted GET starts no fetch", async () => {
    let calls = 0;
    const fetchImpl = createFetchStub(async () => {
      calls += 1;
      return okResponse("ok");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      hesabeRequest({
        fetch: fetchImpl,
        timeoutMs: 1_000,
        url: URL,
        method: "GET",
        headers: HEADERS,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toBe(0);
  });

  it("makes exactly one POST despite 503 (never retries)", async () => {
    let calls = 0;
    const fetchImpl = createFetchStub(
      async () => ((calls += 1), statusResponse(503, "<html>down</html>")),
    );
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 1_000,
      url: URL,
      method: "POST",
      headers: HEADERS,
      body: "{}",
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it("sends method/headers/body with redirect:error and calls onSubmit only for POST", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = createFetchStub(async (url: unknown, init: unknown) => {
      seen.push({ url, ...(init as Record<string, unknown>) });
      return okResponse("abcdef");
    });
    let submitted = 0;
    const text = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 1_000,
      url: URL,
      method: "POST",
      headers: HEADERS,
      body: "payload",
      onSubmit: () => {
        submitted += 1;
      },
    });
    expect(text).toBe("abcdef");
    expect(submitted).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]?.["method"]).toBe("POST");
    expect(seen[0]?.["headers"]).toEqual(HEADERS);
    expect(seen[0]?.["body"]).toBe("payload");
    expect(seen[0]?.["redirect"]).toBe("error");

    let getSubmitted = 0;
    const seenGet: Array<Record<string, unknown>> = [];
    const getFetch = createFetchStub(async (url: unknown, init: unknown) => {
      seenGet.push({ url, ...(init as Record<string, unknown>) });
      return okResponse("ok");
    });
    await hesabeRequest({
      fetch: getFetch,
      timeoutMs: 1_000,
      url: URL,
      method: "GET",
      headers: HEADERS,
      onSubmit: () => {
        getSubmitted += 1;
      },
    });
    expect(getSubmitted).toBe(0);
    expect(seenGet[0]?.["method"]).toBe("GET");
    expect(seenGet[0]?.["redirect"]).toBe("error");
  });

  it("returns raw hex bodies verbatim", async () => {
    const hex = "0e7898bd7464d0c402fe8a949d9cbf9ba";
    const fetchImpl = createFetchStub(async () => okResponse(hex));
    await expect(
      hesabeRequest({
        fetch: fetchImpl,
        timeoutMs: 1_000,
        url: URL,
        method: "POST",
        headers: HEADERS,
        body: hex,
      }),
    ).resolves.toBe(hex);
  });

  it.each([
    { status: 400, expected: InvalidRequestError },
    { status: 401, expected: AuthenticationError },
    { status: 403, expected: AuthenticationError },
    { status: 404, expected: ResourceNotFoundError },
    { status: 429, expected: RateLimitError },
    { status: 500, expected: NetworkError },
    { status: 503, expected: NetworkError },
  ])("classifies HTTP $status without leaking raw bodies", async ({ status, expected }) => {
    const secret = "supersecret-accessCode-Bearer-xyz";
    const fetchImpl = createFetchStub(async () => statusResponse(status, `body:${secret}`));
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 1_000,
      url: URL,
      method: "GET",
      headers: HEADERS,
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(expected);
    expect(String(error?.message)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("timeout covers a hanging POST fetch with afterProviderSubmit", async () => {
    const fetchImpl = createFetchStub(async (_url: unknown, init: unknown) =>
      abortReject((init as { signal?: AbortSignal }).signal ?? null),
    );
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 20,
      url: URL,
      method: "POST",
      headers: HEADERS,
      body: "{}",
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error?.message)).toContain("timed out");
    expect((error as NetworkError).afterProviderSubmit).toBe(true);
  });

  it("timeout covers a hanging GET fetch without afterProviderSubmit", async () => {
    const fetchImpl = createFetchStub(async (_url: unknown, init: unknown) =>
      abortReject((init as { signal?: AbortSignal }).signal ?? null),
    );
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 20,
      url: URL,
      method: "GET",
      headers: HEADERS,
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error?.message)).toContain("timed out");
    expect((error as NetworkError).afterProviderSubmit).toBe(false);
  });

  it("timeout covers a hanging POST response body", async () => {
    const fetchImpl = createFetchStub(async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const hangingText = () =>
        new Promise<string>((_, reject) => {
          const err = Object.assign(new Error("aborted"), {
            name: "AbortError",
          });
          if (signal?.aborted === true) {
            reject(err);
            return;
          }
          signal?.addEventListener("abort", () => reject(err), {
            once: true,
          });
        });
      const pending = hangingText();
      void pending.catch(() => undefined);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => pending,
      } as unknown as Response;
    });
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 20,
      url: URL,
      method: "POST",
      headers: HEADERS,
      body: "{}",
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error?.message)).toContain("timed out");
    expect((error as NetworkError).afterProviderSubmit).toBe(true);
  });

  it("caller abort during POST fetch is ambiguous (NetworkError tagged)", async () => {
    const controller = new AbortController();
    const fetchImpl = createFetchStub(async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const gate = abortReject(signal);
      void gate.catch(() => undefined);
      queueMicrotask(() => controller.abort());
      return gate;
    });
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 1_000,
      url: URL,
      method: "POST",
      headers: HEADERS,
      body: "{}",
      signal: controller.signal,
    }).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).afterProviderSubmit).toBe(true);
  });

  it("caller abort during GET fetch is a clean PaymentAbortedError", async () => {
    const controller = new AbortController();
    const fetchImpl = createFetchStub(async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      const gate = abortReject(signal);
      void gate.catch(() => undefined);
      queueMicrotask(() => controller.abort());
      return gate;
    });
    await expect(
      hesabeRequest({
        fetch: fetchImpl,
        timeoutMs: 1_000,
        url: URL,
        method: "GET",
        headers: HEADERS,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
  });
});

it.each(["fetch", "body"] as const)(
  "times out when %s ignores AbortSignal",
  async (stage) => {
    const fetchImpl = createFetchStub(async () => {
      if (stage === "fetch") return new Promise<Response>(() => {});
      return { text: () => new Promise<string>(() => {}) } as Response;
    });
    const error = await hesabeRequest({
      fetch: fetchImpl,
      timeoutMs: 20,
      url: URL,
      method: "POST",
      headers: HEADERS,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).afterProviderSubmit).toBe(true);
  },
  500,
);
