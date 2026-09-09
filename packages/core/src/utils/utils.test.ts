import { describe, it, expect } from "bun:test";
import {
  withRetry,
  parseRetryAfterSeconds,
  extractRetryAfterSeconds,
} from "./retry";
import { redact, createRedactingLogger, type Logger } from "./logger";
import {
  CaptureParamsSchema,
  CreateCheckoutSessionParamsSchema,
  CreatePaymentParamsSchema,
  RefundParamsSchema,
} from "../types/validation";
import { sha256Hex } from "../runtime/crypto-portable";
import { resolveDefaultCrypto } from "../runtime/crypto-provider";
import {
  InMemoryIdempotencyStore,
  fingerprintParams,
  stableStringifyParams,
} from "./idempotency";
import { money } from "./money";

describe("withRetry", () => {
  const fastConfig = { baseDelayMs: 0, maxDelayMs: 0 };

  it("retries retryable failures and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      { isRetryable: () => true, config: fastConfig },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable failures", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("permanent");
        },
        { isRetryable: () => false, config: fastConfig },
      ),
    ).rejects.toThrow("permanent");
    expect(attempts).toBe(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error(`fail-${attempts}`);
        },
        { isRetryable: () => true, config: { ...fastConfig, maxAttempts: 4 } },
      ),
    ).rejects.toThrow("fail-4");
    expect(attempts).toBe(4);
  });

  it("clamps maxAttempts to at least 1 (maxAttempts 0 still runs once)", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return "once";
      },
      { isRetryable: () => true, config: { ...fastConfig, maxAttempts: 0 } },
    );
    expect(result).toBe("once");
    expect(attempts).toBe(1);
  });

  it("clamps negative maxAttempts to 1 and still surfaces a single failure", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("boom");
        },
        { isRetryable: () => true, config: { ...fastConfig, maxAttempts: -3 } },
      ),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });

  it("honors Retry-After above maxDelayMs (does not clamp to maxDelayMs)", async () => {
    const delays: number[] = [];
    let attempts = 0;
    // Avoid actually sleeping 120s: force the scheduled delay to 0 while
    // still recording the delay the default policy computed via onRetry.
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test stub
    globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
      originalSetTimeout(fn, 0)) as typeof setTimeout;

    try {
      await withRetry(
        async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error("rate limited") as Error & {
              retryAfterSeconds: number;
            };
            err.retryAfterSeconds = 120;
            throw err;
          }
          return "ok";
        },
        {
          isRetryable: () => true,
          config: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
          onRetry: (_err, _attempt, delayMs) => {
            delays.push(delayMs);
          },
        },
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(attempts).toBe(2);
    expect(delays).toHaveLength(1);
    // 120s must be respected even though maxDelayMs is only 5s
    expect(delays[0]).toBe(120_000);
  });

  it("clamps oversized Retry-After to the 120s high ceiling", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test stub
    globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
      originalSetTimeout(fn, 0)) as typeof setTimeout;

    try {
      await withRetry(
        async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error("rate limited") as Error & {
              retryAfterSeconds: number;
            };
            err.retryAfterSeconds = 999;
            throw err;
          }
          return "ok";
        },
        {
          isRetryable: () => true,
          config: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 },
          onRetry: (_err, _attempt, delayMs) => {
            delays.push(delayMs);
          },
        },
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(delays[0]).toBe(120_000);
  });

  it("applies full-jitter on exponential backoff (delay in [0, expCap])", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test stub
    globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
      originalSetTimeout(fn, 0)) as typeof setTimeout;

    try {
      await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("transient");
          return "ok";
        },
        {
          isRetryable: () => true,
          config: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 },
          onRetry: (_err, _attempt, delayMs) => {
            delays.push(delayMs);
          },
        },
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // attempt 0: cap = 100; attempt 1: cap = 200
    expect(delays).toHaveLength(2);
    expect(delays[0]!).toBeGreaterThanOrEqual(0);
    expect(delays[0]!).toBeLessThanOrEqual(100);
    expect(delays[1]!).toBeGreaterThanOrEqual(0);
    expect(delays[1]!).toBeLessThanOrEqual(200);
  });

  it("sanitizes custom getRetryDelayMs NaN/negative/∞/oversized (MONEY-5)", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test stub
    globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
      originalSetTimeout(fn, 0)) as typeof setTimeout;

    try {
      const runOnce = async (getDelay: () => number) => {
        let n = 0;
        await withRetry(
          async () => {
            n++;
            if (n === 1) throw new Error("transient");
            return "ok";
          },
          {
            isRetryable: () => true,
            config: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 5_000 },
            getRetryDelayMs: getDelay,
            onRetry: (_e, _a, delayMs) => {
              delays.push(delayMs);
            },
          },
        );
        attempts += n;
      };
      await runOnce(() => Number.NaN);
      await runOnce(() => -50);
      await runOnce(() => Number.POSITIVE_INFINITY);
      await runOnce(() => 999_999_999);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(delays).toHaveLength(4);
    // NaN / negative / non-finite → 0; finite oversized clamped to high ceiling
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(0);
    expect(delays[2]).toBe(0);
    expect(delays[3]).toBe(120_000);
    expect(attempts).toBe(8);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses numeric delta-seconds", () => {
    const headers = new Headers({ "retry-after": "30" });
    expect(parseRetryAfterSeconds(headers)).toBe(30);
  });

  it("returns undefined when header absent", () => {
    expect(parseRetryAfterSeconds(new Headers())).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
  });

  it("parses HTTP-date Retry-After into positive seconds from now", () => {
    // ~60s in the future; allow small clock skew in the assertion window
    const future = new Date(Date.now() + 60_000).toUTCString();
    const headers = new Headers({ "retry-after": future });
    const seconds = parseRetryAfterSeconds(headers);
    expect(seconds).toBeDefined();
    expect(seconds!).toBeGreaterThan(0);
    expect(seconds!).toBeLessThanOrEqual(120);
  });

  it("returns undefined for invalid non-numeric Retry-After values", () => {
    const headers = new Headers({ "retry-after": "not-a-date" });
    expect(parseRetryAfterSeconds(headers)).toBeUndefined();
  });

  it("returns undefined for HTTP-date Retry-After already in the past", () => {
    const past = new Date(Date.now() - 120_000).toUTCString();
    const headers = new Headers({ "retry-after": past });
    expect(parseRetryAfterSeconds(headers)).toBeUndefined();
  });
});

describe("extractRetryAfterSeconds", () => {
  it("reads retryAfterSeconds from an error object", () => {
    expect(extractRetryAfterSeconds({ retryAfterSeconds: 12 })).toBe(12);
    expect(extractRetryAfterSeconds(new Error("x"))).toBeUndefined();
  });
});

describe("redact", () => {
  it("redacts sensitive keys at any depth", () => {
    const input = {
      amount: 100,
      card: { number: "4242424242424242", brand: "visa" },
      customerEmail: "a@b.com",
      authorization: "Bearer secret",
      nested: { token: "tok_123", note: "ok" },
      items: [{ name: "Phone", price: 10 }],
    };

    const out = redact(input) as Record<string, any>;

    expect(out.amount).toBe(100);
    expect(out.card).toBe("[REDACTED]");
    expect(out.customerEmail).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.nested.note).toBe("ok");
    expect(out.items[0].name).toBe("[REDACTED]");
    expect(out.items[0].price).toBe(10);
  });

  it("does not mutate the input", () => {
    const input = { token: "tok_123" };
    redact(input);
    expect(input.token).toBe("tok_123");
  });

  it("keeps safe operational keys while still redacting PII name fields", () => {
    const out = redact({
      gateway: "stripe",
      gatewayName: "stripe",
      operationName: "createPayment",
      eventType: "payment_intent.succeeded",
      firstName: "Jane",
      lastName: "Doe",
      cardNumber: "4242424242424242",
    }) as Record<string, unknown>;

    expect(out.gateway).toBe("stripe");
    expect(out.gatewayName).toBe("stripe");
    expect(out.operationName).toBe("createPayment");
    expect(out.eventType).toBe("payment_intent.succeeded");
    expect(out.firstName).toBe("[REDACTED]");
    expect(out.lastName).toBe("[REDACTED]");
    expect(out.cardNumber).toBe("[REDACTED]");
  });

  it("allowlists payment identity keys that would otherwise match sensitive substrings", () => {
    const out = redact({
      idempotencyKey: "idem_abc",
      authorizationId: "AUTH-1",
      gatewayPaymentId: "pi_123",
      gatewayId: "pi_123",
      captureId: "CAP-1",
      orderId: "ORD-1",
      paymentId: "pay_1",
      // OBS-1: operational flag must not be redacted by substring "auth"
      authorized: true,
      authorization: "Bearer secret",
      apiKey: "sk_live_xxx",
    }) as Record<string, unknown>;

    expect(out.idempotencyKey).toBe("idem_abc");
    expect(out.authorizationId).toBe("AUTH-1");
    expect(out.gatewayPaymentId).toBe("pi_123");
    expect(out.gatewayId).toBe("pi_123");
    expect(out.captureId).toBe("CAP-1");
    expect(out.orderId).toBe("ORD-1");
    expect(out.paymentId).toBe("pay_1");
    expect(out.authorized).toBe(true);
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
  });

  it("allowlists Phase 20 OperationContext / telemetry diagnostic keys", () => {
    const out = redact({
      operationId: "op_1",
      operationType: "payment.create",
      providerRequestId: "req_abc",
      providerObjectId: "pi_123",
      internalReference: "ord_1",
      attemptNumber: 2,
      durationMs: 12,
      duration: 12,
      tenant: "acme",
      namespace: "prod",
      inboxEventKey: "inbox:evt_1",
      eventKey: "evt_1",
      normalizedOutcome: "succeeded",
      outcome: "succeeded",
      reconciliationRequired: true,
      retry: false,
      retryable: true,
      errorName: "TimeoutError",
      exceptionType: "TimeoutError",
      // Still sensitive — must not weaken PII redaction
      firstName: "Jane",
      cardNumber: "4242424242424242",
      secretToken: "tok_x",
    }) as Record<string, unknown>;

    expect(out.operationId).toBe("op_1");
    expect(out.operationType).toBe("payment.create");
    expect(out.providerRequestId).toBe("req_abc");
    expect(out.providerObjectId).toBe("pi_123");
    expect(out.internalReference).toBe("ord_1");
    expect(out.attemptNumber).toBe(2);
    expect(out.durationMs).toBe(12);
    expect(out.duration).toBe(12);
    expect(out.tenant).toBe("acme");
    expect(out.namespace).toBe("prod");
    expect(out.inboxEventKey).toBe("inbox:evt_1");
    expect(out.eventKey).toBe("evt_1");
    expect(out.normalizedOutcome).toBe("succeeded");
    expect(out.outcome).toBe("succeeded");
    expect(out.reconciliationRequired).toBe(true);
    expect(out.errorName).toBe("TimeoutError");
    expect(out.exceptionType).toBe("TimeoutError");
    expect(out.retry).toBe(false);
    expect(out.retryable).toBe(true);
    expect(out.firstName).toBe("[REDACTED]");
    expect(out.cardNumber).toBe("[REDACTED]");
    expect(out.secretToken).toBe("[REDACTED]");
  });

  it("redacts banking / government identifier keys (iban, bank, ssn, pin)", () => {
    const out = redact({
      iban: "DE89370400440532013000",
      bankAccount: "12345678",
      bankCode: "1100000",
      ssn: "123-45-6789",
      pin: "1234",
      pinCode: "9999",
      // Operational ids stay visible
      refundId: "re_1",
      customerId: "cus_1",
      amount: 10.5,
      currency: "SAR",
    }) as Record<string, unknown>;

    expect(out.iban).toBe("[REDACTED]");
    expect(out.bankAccount).toBe("[REDACTED]");
    expect(out.bankCode).toBe("[REDACTED]");
    expect(out.ssn).toBe("[REDACTED]");
    expect(out.pin).toBe("[REDACTED]");
    expect(out.pinCode).toBe("[REDACTED]");
    expect(out.refundId).toBe("re_1");
    expect(out.customerId).toBe("cus_1");
    expect(out.amount).toBe(10.5);
    expect(out.currency).toBe("SAR");
  });

  it("redacts card expiry and tax/DOB-style keys without over-matching", () => {
    const out = redact({
      expiry: "12/30",
      expiration: "12/30",
      exp_month: 12,
      exp_year: 2030,
      expMonth: 12,
      expYear: 2030,
      dob: "1990-01-01",
      dateOfBirth: "1990-01-01",
      date_of_birth: "1990-01-01",
      tax_id: "12-3456789",
      taxId: "12-3456789",
      nationalId: "NIN-1",
      national_id: "NIN-1",
      // Must remain visible (bare "exp"/"tax" would over-match these)
      expectedStatus: "paid",
      exportFormat: "json",
      syntaxTree: true,
    }) as Record<string, unknown>;

    expect(out.expiry).toBe("[REDACTED]");
    expect(out.expiration).toBe("[REDACTED]");
    expect(out.exp_month).toBe("[REDACTED]");
    expect(out.exp_year).toBe("[REDACTED]");
    expect(out.expMonth).toBe("[REDACTED]");
    expect(out.expYear).toBe("[REDACTED]");
    expect(out.dob).toBe("[REDACTED]");
    expect(out.dateOfBirth).toBe("[REDACTED]");
    expect(out.date_of_birth).toBe("[REDACTED]");
    expect(out.tax_id).toBe("[REDACTED]");
    expect(out.taxId).toBe("[REDACTED]");
    expect(out.nationalId).toBe("[REDACTED]");
    expect(out.national_id).toBe("[REDACTED]");
    expect(out.expectedStatus).toBe("paid");
    expect(out.exportFormat).toBe("json");
    expect(out.syntaxTree).toBe(true);
  });

  it("redacts cookie / passwd / pwd / otp / credentials / credential without over-matching", () => {
    const out = redact({
      cookie: "session=abc",
      setCookie: "sid=xyz",
      passwd: "hunter2",
      pwd: "hunter2",
      userPwd: "hunter2",
      otp: "123456",
      otpValue: "654321",
      totpCode: "999999",
      credentials: { user: "a", pass: "b" },
      // MONEY-6: singular credential form
      credential: "secret-cred",
      userCredential: "user-secret",
      // Must remain visible — bare patterns must not substring-match these
      // (password already covered elsewhere; outcome/status stay diagnostic)
      outcome: "succeeded",
      status: "paid",
      amount: 10.5,
      currency: "SAR",
    }) as Record<string, unknown>;

    expect(out.cookie).toBe("[REDACTED]");
    expect(out.setCookie).toBe("[REDACTED]");
    expect(out.passwd).toBe("[REDACTED]");
    expect(out.pwd).toBe("[REDACTED]");
    expect(out.userPwd).toBe("[REDACTED]");
    expect(out.otp).toBe("[REDACTED]");
    expect(out.otpValue).toBe("[REDACTED]");
    expect(out.totpCode).toBe("[REDACTED]");
    expect(out.credentials).toBe("[REDACTED]");
    expect(out.credential).toBe("[REDACTED]");
    expect(out.userCredential).toBe("[REDACTED]");
    expect(out.outcome).toBe("succeeded");
    expect(out.status).toBe("paid");
    expect(out.amount).toBe(10.5);
    expect(out.currency).toBe("SAR");
  });

  it("redacts mobile / cryptogram / security_code and opaque PAN-like strings (MONEY-2)", () => {
    const out = redact({
      mobile: "0512345678",
      customerMobile: "966512345678",
      cryptogram: "AAABBBcccDDD==",
      networkCryptogram: "xyz",
      security_code: "123",
      securityCode: "456",
      note: "ok",
      // Opaque blob under a non-sensitive key
      raw: "4242424242424242",
      spaced: "4242 4242 4242 4242",
      shortDigits: "1234567890",
      amount: 10,
    }) as Record<string, unknown>;

    expect(out.mobile).toBe("[REDACTED]");
    expect(out.customerMobile).toBe("[REDACTED]");
    expect(out.cryptogram).toBe("[REDACTED]");
    expect(out.networkCryptogram).toBe("[REDACTED]");
    expect(out.security_code).toBe("[REDACTED]");
    expect(out.securityCode).toBe("[REDACTED]");
    expect(out.note).toBe("ok");
    expect(out.raw).toBe("[REDACTED]");
    expect(out.spaced).toBe("[REDACTED]");
    expect(out.shortDigits).toBe("1234567890");
    expect(out.amount).toBe(10);
  });

  it("redacts secret-shaped leaves under non-sensitive keys (MONEY-3)", () => {
    const out = redact({
      note: "sk_live_51HxExampleSecretKeyValue",
      detail: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      webhookHint: "whsec_abc123XYZ",
      safeNote: "order shipped",
      amount: 10,
    }) as Record<string, unknown>;

    expect(out.note).toBe("[REDACTED]");
    expect(out.detail).toBe("[REDACTED]");
    expect(out.webhookHint).toBe("[REDACTED]");
    expect(out.safeNote).toBe("order shipped");
    expect(out.amount).toBe(10);
  });

  it("redacts Stripe PI client secrets on allow-listed leaves (NEW-OBS-2)", () => {
    const piSecret = "pi_3N3xYZABC_secret_abc123def";
    const out = redact({
      providerObjectId: piSecret,
      gatewayPaymentId: "pi_3N3xYZABC",
      note: `next_action ${piSecret}`,
      amount: 10,
    }) as Record<string, unknown>;

    expect(out.providerObjectId).toBe("[REDACTED]");
    expect(out.gatewayPaymentId).toBe("pi_3N3xYZABC");
    expect(out.note).toBe("[REDACTED]");
    expect(out.amount).toBe(10);
    expect(JSON.stringify(out)).not.toContain("_secret_");
    expect(JSON.stringify(out)).not.toContain(piSecret);
  });

  it("redacts SetupIntent client secrets and PayPal A21 tokens on allow-listed leaves (NEW-OBS-3)", () => {
    const setiSecret = "seti_1MqLiJLkdIwHu7ix_secret_NbqtAIXdFSJwUCNa";
    const paypalA21AA =
      "A21AAFEpjF0wAHLmN8s7xKzExamplePayPalAccessTokenValueXYZ123456";
    const paypalA21Alnum = "A21BCdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    const out = redact({
      providerObjectId: setiSecret,
      internalReference: paypalA21AA,
      gatewayPaymentId: "seti_1MqLiJLkdIwHu7ix",
      note: `oauth ${paypalA21Alnum}`,
      shortPrefix: "A21AA",
      amount: 10,
    }) as Record<string, unknown>;

    expect(out.providerObjectId).toBe("[REDACTED]");
    expect(out.internalReference).toBe("[REDACTED]");
    expect(out.gatewayPaymentId).toBe("seti_1MqLiJLkdIwHu7ix");
    expect(out.note).toBe("[REDACTED]");
    expect(out.shortPrefix).toBe("A21AA");
    expect(out.amount).toBe(10);
    expect(JSON.stringify(out)).not.toContain("_secret_");
    expect(JSON.stringify(out)).not.toContain(setiSecret);
    expect(JSON.stringify(out)).not.toContain("A21AAFEpj");
    expect(JSON.stringify(out)).not.toContain(paypalA21Alnum);
  });

  it("redacts embedded sk_live_ / PAN inside hookError strings (MONEY-3)", () => {
    const out = redact({
      hookError: "after hook threw: sk_live_51HxExampleSecretKeyValue",
      detail: "card 4242424242424242 declined",
      safe: "after hook threw: timeout",
    }) as Record<string, unknown>;

    expect(out.hookError).toBe("[REDACTED]");
    expect(out.detail).toBe("[REDACTED]");
    expect(String(out.hookError)).not.toContain("sk_live_");
    expect(String(out.detail)).not.toContain("4242424242424242");
    expect(out.safe).toBe("after hook threw: timeout");
  });

  it("redacts bare month/year card expiry and CVC aliases (MONEY-4)", () => {
    const out = redact({
      // Moyasar source card fields
      month: 12,
      year: 2029,
      Month: 1,
      Year: 2030,
      cvc2: "123",
      cvv2: "456",
      cid: "789",
      // Must not over-redact operational / non-expiry keys that merely contain substrings
      monthlyTotal: 100,
      yearToDate: 200,
      fiscalYear: 2024,
      amount: 10.5,
      currency: "SAR",
    }) as Record<string, unknown>;

    expect(out.month).toBe("[REDACTED]");
    expect(out.year).toBe("[REDACTED]");
    expect(out.Month).toBe("[REDACTED]");
    expect(out.Year).toBe("[REDACTED]");
    expect(out.cvc2).toBe("[REDACTED]");
    expect(out.cvv2).toBe("[REDACTED]");
    expect(out.cid).toBe("[REDACTED]");
    expect(out.monthlyTotal).toBe(100);
    expect(out.yearToDate).toBe(200);
    expect(out.fiscalYear).toBe(2024);
    expect(out.amount).toBe(10.5);
    expect(out.currency).toBe("SAR");
  });
});

describe("CreateCheckoutSession image URL schemes (CORE-3)", () => {
  it("rejects non-http(s) product image URLs", () => {
    const base = {
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel",
      lineItems: [
        {
          quantity: 1,
          priceData: {
            currency: "usd",
            productData: {
              name: "Widget",
              images: ["javascript:alert(1)"],
            },
            unitAmount: 100,
          },
        },
      ],
    };
    expect(CreateCheckoutSessionParamsSchema.safeParse(base).success).toBe(
      false,
    );
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        ...base,
        lineItems: [
          {
            quantity: 1,
            priceData: {
              currency: "usd",
              productData: {
                name: "Widget",
                images: ["https://cdn.example.com/p.png"],
              },
              unitAmount: 100,
            },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("CreateCheckoutSessionParamsSchema cancelUrl (P22R3-CANCEL-URL)", () => {
  const paymentBase = {
    successUrl: "https://example.com/ok",
    amount: money("10.00", "USD"),
    currency: "USD",
  };
  const subscriptionBase = {
    mode: "subscription" as const,
    successUrl: "https://example.com/ok",
    lineItems: [{ price: "price_1", quantity: 1 }],
  };

  it("requires cancelUrl for payment mode (default)", () => {
    const parsed = CreateCheckoutSessionParamsSchema.safeParse(paymentBase);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      expect.unreachable("payment mode without cancelUrl must fail");
    }
    expect(
      parsed.error.issues.some((issue) => issue.path[0] === "cancelUrl"),
    ).toBe(true);
  });

  it("requires cancelUrl for explicit mode payment", () => {
    const parsed = CreateCheckoutSessionParamsSchema.safeParse({
      ...paymentBase,
      mode: "payment",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      expect.unreachable("explicit payment mode without cancelUrl must fail");
    }
    expect(
      parsed.error.issues.some((issue) => issue.path[0] === "cancelUrl"),
    ).toBe(true);
  });

  it("requires cancelUrl for subscription mode", () => {
    const parsed =
      CreateCheckoutSessionParamsSchema.safeParse(subscriptionBase);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      expect.unreachable("subscription mode without cancelUrl must fail");
    }
    expect(
      parsed.error.issues.some((issue) => issue.path[0] === "cancelUrl"),
    ).toBe(true);
  });

  it("allows omitting cancelUrl in setup mode", () => {
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        mode: "setup",
        successUrl: "https://example.com/ok",
        currency: "USD",
      }).success,
    ).toBe(true);
  });

  it("accepts http(s) cancelUrl for payment and subscription", () => {
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        ...paymentBase,
        cancelUrl: "https://example.com/cancel",
      }).success,
    ).toBe(true);
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        ...subscriptionBase,
        cancelUrl: "http://merchant.example/cancel",
      }).success,
    ).toBe(true);
  });

  it("rejects javascript: cancelUrl and successUrl", () => {
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        ...paymentBase,
        cancelUrl: "javascript:void(0)",
      }).success,
    ).toBe(false);
    expect(
      CreateCheckoutSessionParamsSchema.safeParse({
        ...paymentBase,
        successUrl: "javascript:alert(1)",
        cancelUrl: "https://example.com/cancel",
      }).success,
    ).toBe(false);
  });
});

describe("InMemoryIdempotencyStore clone fail-closed (MONEY-4)", () => {
  it("refuses to store non-cloneable result graphs", () => {
    const store = new InMemoryIdempotencyStore();
    // structuredClone fails on functions; JSON.stringify fails on cycles → throw
    // (plain cycles alone are cloneable via structuredClone)
    const uncloneable: Record<string, unknown> = { fn: () => {} };
    uncloneable.self = uncloneable;
    expect(() =>
      store.set("k_uncloneable", {
        status: "completed",
        fingerprint: "fp",
        createdAt: Date.now(),
        result: uncloneable,
      }),
    ).toThrow(/not cloneable/);
  });
});

describe("idempotencyKey validation (CORE-2)", () => {
  it("rejects empty and whitespace-only idempotency keys", () => {
    const base = {
      amount: money("10.00", "USD"),
      currency: "USD",
      callbackUrl: "https://example.com/callback",
    };
    expect(
      CreatePaymentParamsSchema.safeParse({ ...base, idempotencyKey: "" })
        .success,
    ).toBe(false);
    expect(
      CreatePaymentParamsSchema.safeParse({
        ...base,
        idempotencyKey: "   ",
      }).success,
    ).toBe(false);
    expect(
      CreatePaymentParamsSchema.safeParse({
        ...base,
        idempotencyKey: "\t\n",
      }).success,
    ).toBe(false);
    expect(
      CaptureParamsSchema.safeParse({
        gatewayPaymentId: "pay_1",
        idempotencyKey: "  ",
      }).success,
    ).toBe(false);
    expect(
      RefundParamsSchema.safeParse({
        gatewayPaymentId: "pay_1",
        idempotencyKey: " ",
      }).success,
    ).toBe(false);
  });

  it("accepts non-empty keys including those with internal spaces", () => {
    const parsed = CreatePaymentParamsSchema.safeParse({
      amount: money("10.00", "USD"),
      currency: "USD",
      callbackUrl: "https://example.com/callback",
      idempotencyKey: "order-123 retry",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("resolveDefaultCrypto (CORE-3)", () => {
  it("uses Web Crypto when available", () => {
    const provider = resolveDefaultCrypto();
    const id = provider.randomUUID();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const bytes = new Uint8Array(8);
    provider.getRandomValues(bytes);
    expect(bytes.length).toBe(8);
  });

  it("throws when Web Crypto is absent (no Math.random fallback)", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(() => resolveDefaultCrypto()).toThrow(/Web Crypto API is unavailable/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("createRedactingLogger", () => {
  it("redacts structured context before forwarding", () => {
    const calls: Array<[string, unknown]> = [];
    const sink: Logger = {
      debug: () => {},
      info: () => {},
      warn: (m, c) => calls.push([m, c]),
      error: () => {},
    };

    const logger = createRedactingLogger(sink);
    logger.warn("charging", { amount: 5, card: { number: "4242" } });

    expect(calls[0]![0]).toBe("charging");
    expect((calls[0]![1] as any).amount).toBe(5);
    expect((calls[0]![1] as any).card).toBe("[REDACTED]");
  });

  it("sanitizes PI client secrets in the message and allow-listed context (NEW-OBS-2)", () => {
    const calls: Array<[string, unknown?]> = [];
    const sink: Logger = {
      debug: () => {},
      info: (m, c) => calls.push([m, c]),
      warn: () => {},
      error: () => {},
    };
    const logger = createRedactingLogger(sink);
    const piSecret = "pi_3N3xYZABC_secret_abc123def";

    logger.info(`next_action ${piSecret}`, {
      providerObjectId: piSecret,
      gatewayPaymentId: "pi_3N3xYZABC",
      amount: 12,
    });
    logger.info(piSecret);

    expect(calls[0]![0]).toBe("next_action [REDACTED]");
    expect(calls[0]![0]).not.toContain("_secret_");
    expect(calls[0]![0]).not.toContain(piSecret);
    const ctx = calls[0]![1] as Record<string, unknown>;
    expect(ctx.providerObjectId).toBe("[REDACTED]");
    expect(ctx.gatewayPaymentId).toBe("pi_3N3xYZABC");
    expect(ctx.amount).toBe(12);
    expect(JSON.stringify(ctx)).not.toContain(piSecret);

    expect(calls[1]![0]).toBe("[REDACTED]");
    expect(calls[1]![0]).not.toContain("pi_");
  });

  it("sanitizes seti client secrets and PayPal A21 tokens in messages (NEW-OBS-3)", () => {
    const calls: Array<[string, unknown?]> = [];
    const sink: Logger = {
      debug: () => {},
      info: (m, c) => calls.push([m, c]),
      warn: () => {},
      error: () => {},
    };
    const logger = createRedactingLogger(sink);
    const setiSecret = "seti_1MqLiJLkdIwHu7ix_secret_NbqtAIXdFSJwUCNa";
    const paypalA21AA =
      "A21AAFEpjF0wAHLmN8s7xKzExamplePayPalAccessTokenValueXYZ123456";

    logger.info(`next_action ${setiSecret}`, {
      providerObjectId: setiSecret,
      gatewayPaymentId: "seti_1MqLiJLkdIwHu7ix",
    });
    logger.info(`oauth failed ${paypalA21AA}`, {
      internalReference: paypalA21AA,
      amount: 4,
    });
    logger.info(setiSecret);
    logger.info(paypalA21AA);

    expect(calls[0]![0]).toBe("next_action [REDACTED]");
    expect(calls[0]![0]).not.toContain("_secret_");
    expect(calls[0]![0]).not.toContain(setiSecret);
    const setiCtx = calls[0]![1] as Record<string, unknown>;
    expect(setiCtx.providerObjectId).toBe("[REDACTED]");
    expect(setiCtx.gatewayPaymentId).toBe("seti_1MqLiJLkdIwHu7ix");

    expect(calls[1]![0]).toBe("oauth failed [REDACTED]");
    expect(calls[1]![0]).not.toContain("A21AAFEpj");
    const tokenCtx = calls[1]![1] as Record<string, unknown>;
    expect(tokenCtx.internalReference).toBe("[REDACTED]");
    expect(tokenCtx.amount).toBe(4);
    expect(JSON.stringify(tokenCtx)).not.toContain(paypalA21AA);

    expect(calls[2]![0]).toBe("[REDACTED]");
    expect(calls[3]![0]).toBe("[REDACTED]");
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("reserves a free key and reports existing on second reserve", () => {
    const store = new InMemoryIdempotencyStore();
    const record = { status: "in_progress" as const, fingerprint: "fp", createdAt: Date.now() };

    expect(store.reserve("k", record)).toBeUndefined();
    expect(store.reserve("k", record)).toEqual(record);
  });

  it("pins unknown/in_progress/completed past TTL (MONEY-2); explicit delete clears", () => {
    const store = new InMemoryIdempotencyStore(1);
    store.set("u", { status: "unknown", fingerprint: "u", createdAt: Date.now() });
    store.set("c", { status: "completed", fingerprint: "c", createdAt: Date.now() });
    store.set("p", { status: "in_progress", fingerprint: "p", createdAt: Date.now() });
    expect(store.get("u")).toBeDefined();
    expect(store.get("c")).toBeDefined();
    expect(store.get("p")).toBeDefined();
    // Wait past the 1ms TTL.
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    // MONEY-2: indeterminate `unknown` fences pin like completed/in_progress.
    expect(store.get("u")?.status).toBe("unknown");
    expect(store.get("c")?.status).toBe("completed");
    expect(store.get("p")?.status).toBe("in_progress");
    // Explicit delete still clears protected fences.
    store.delete("c");
    expect(store.get("c")).toBeUndefined();
    store.delete("u");
    expect(store.get("u")).toBeUndefined();
  });

  it("refuses new keys when full of protected fences including unknown (MONEY-2)", () => {
    const store = new InMemoryIdempotencyStore(60_000, 3);
    store.set("a", { status: "unknown", fingerprint: "a", createdAt: 1 });
    store.set("b", { status: "completed", fingerprint: "b", createdAt: 2 });
    store.set("c", { status: "in_progress", fingerprint: "c", createdAt: 3 });

    // All three are protected — refuse rather than evict unknown under pressure.
    expect(() =>
      store.set("d", { status: "unknown", fingerprint: "d", createdAt: 4 }),
    ).toThrow(/protected fence keys/);
    expect(store.get("a")?.status).toBe("unknown");
    expect(store.get("b")?.status).toBe("completed");
    expect(store.get("c")?.status).toBe("in_progress");
    expect(store.size).toBe(3);

    // Full of protected keys → refuse new key rather than drop mutation guards.
    const full = new InMemoryIdempotencyStore(60_000, 2);
    full.set("p1", { status: "completed", fingerprint: "1", createdAt: 1 });
    full.set("p2", { status: "in_progress", fingerprint: "2", createdAt: 2 });
    expect(() =>
      full.set("p3", { status: "completed", fingerprint: "3", createdAt: 3 }),
    ).toThrow(/protected fence keys/);
    expect(full.get("p1")).toBeDefined();
    expect(full.get("p2")).toBeDefined();
    expect(full.size).toBe(2);

    // unknown-only capacity is also protected (indeterminate mutation fences).
    const unknowns = new InMemoryIdempotencyStore(60_000, 2);
    unknowns.set("u1", { status: "unknown", fingerprint: "1", createdAt: 1 });
    unknowns.set("u2", { status: "unknown", fingerprint: "2", createdAt: 2 });
    expect(() =>
      unknowns.set("u3", { status: "unknown", fingerprint: "3", createdAt: 3 }),
    ).toThrow(/protected fence keys/);
    expect(unknowns.get("u1")?.status).toBe("unknown");
    expect(unknowns.get("u2")?.status).toBe("unknown");
    expect(unknowns.size).toBe(2);
  });

  it("clones records on get/set so callers cannot mutate the live cache", () => {
    const store = new InMemoryIdempotencyStore();
    const result = { status: "paid", amount: 10.5 };
    const record = {
      status: "completed" as const,
      fingerprint: "fp",
      createdAt: 1,
      result,
    };

    store.set("k", record);

    // Mutating the caller's original must not affect the store.
    record.status = "in_progress";
    record.fingerprint = "tampered";
    result.status = "failed";

    const got = store.get("k");
    expect(got).toEqual({
      status: "completed",
      fingerprint: "fp",
      createdAt: 1,
      result: { status: "paid", amount: 10.5 },
    });

    // Mutating the returned record must not affect a subsequent get.
    got!.status = "unknown";
    (got!.result as { status: string }).status = "refunded";
    expect(store.get("k")).toEqual({
      status: "completed",
      fingerprint: "fp",
      createdAt: 1,
      result: { status: "paid", amount: 10.5 },
    });
  });

  it("clones records returned from reserve", () => {
    const store = new InMemoryIdempotencyStore();
    const record = {
      status: "in_progress" as const,
      fingerprint: "fp",
      createdAt: 1,
    };
    expect(store.reserve("k", record)).toBeUndefined();

    const existing = store.reserve("k", {
      status: "in_progress",
      fingerprint: "other",
      createdAt: 2,
    });
    expect(existing).toEqual({
      status: "in_progress",
      fingerprint: "fp",
      createdAt: 1,
    });
    existing!.fingerprint = "mutated";
    expect(store.get("k")?.fingerprint).toBe("fp");
  });

  it("move-to-end on update of protected fences; capacity still refuses (MONEY-2)", () => {
    const store = new InMemoryIdempotencyStore(60_000, 3);
    store.set("a", { status: "unknown", fingerprint: "a", createdAt: 1 });
    store.set("b", { status: "unknown", fingerprint: "b", createdAt: 2 });
    store.set("c", { status: "completed", fingerprint: "c", createdAt: 3 });

    // Refresh "a" in place (update does not grow size).
    store.set("a", {
      status: "unknown",
      fingerprint: "a-updated",
      createdAt: 1,
      result: { ok: true },
    });

    expect(store.get("a")?.fingerprint).toBe("a-updated");
    expect(store.get("a")?.result).toEqual({ ok: true });
    expect(store.get("b")?.status).toBe("unknown");
    expect(store.get("c")?.status).toBe("completed");
    expect(store.size).toBe(3);

    // New key still refused — unknowns are protected fences.
    expect(() =>
      store.set("d", { status: "unknown", fingerprint: "d", createdAt: 4 }),
    ).toThrow(/protected fence keys/);
    expect(store.size).toBe(3);
  });
});

describe("fingerprintParams", () => {
  it("is stable regardless of key order", () => {
    expect(fingerprintParams({ a: 1, b: 2 })).toBe(fingerprintParams({ b: 2, a: 1 }));
  });

  it("differs when values differ", () => {
    expect(fingerprintParams({ amount: 50 })).not.toBe(fingerprintParams({ amount: 60 }));
  });

  it("encodes undefined distinctly from null", () => {
    expect(fingerprintParams(undefined)).not.toBe(fingerprintParams(null));
    expect(fingerprintParams({ a: undefined })).not.toBe(fingerprintParams({ a: null }));
    expect(fingerprintParams([undefined])).not.toBe(fingerprintParams([null]));
  });

  it("canonicalizes Money / AmountInput so economically identical amounts match", () => {
    const asMoney = money("10.50", "SAR");
    const asNumber = 10.5;
    const asPadded = money("10.5", "SAR");

    // Top-level Money vs plain { amount, currency }
    expect(fingerprintParams(asMoney)).toBe(
      fingerprintParams({ amount: "10.50", currency: "SAR" }),
    );
    expect(fingerprintParams(asMoney)).toBe(fingerprintParams(asPadded));

    // money("10.50","SAR") ≡ number 10.5 with currency SAR
    expect(fingerprintParams(asMoney)).toBe(
      fingerprintParams({ amount: asNumber, currency: "SAR" }),
    );

    // Moyasar-style mutation fingerprint: amount is number | Money
    expect(
      fingerprintParams({ amount: asMoney, currency: "SAR" }),
    ).toBe(fingerprintParams({ amount: asNumber, currency: "SAR" }));
    expect(
      fingerprintParams({ amount: asMoney, currency: "SAR" }),
    ).toBe(fingerprintParams({ amount: "10.50", currency: "SAR" }));
    expect(
      fingerprintParams({ amount: asNumber, currency: "sar" }),
    ).toBe(fingerprintParams({ amount: "10.5", currency: "SAR" }));
  });

  it("preserves sibling keys on Money-shaped bags (no orderId collision)", () => {
    // Duck-typed Money + extra fields must not drop siblings after canonicalize.
    const a = fingerprintParams({
      amount: "10.00",
      currency: "USD",
      orderId: "A",
    });
    const b = fingerprintParams({
      amount: "10.00",
      currency: "USD",
      orderId: "B",
    });
    expect(a).not.toBe(b);

    // Amount forms still collapse while siblings remain distinct.
    expect(
      fingerprintParams({ amount: 10, currency: "usd", orderId: "A" }),
    ).toBe(
      fingerprintParams({ amount: "10.00", currency: "USD", orderId: "A" }),
    );
    expect(
      fingerprintParams({
        amount: money("10.00", "USD"),
        currency: "USD",
        orderId: "A",
      }),
    ).toBe(
      fingerprintParams({ amount: "10.00", currency: "USD", orderId: "A" }),
    );
  });

  it("keeps nested Money currency when sibling currency mismatches", () => {
    const nested = fingerprintParams({
      amount: money("10.50", "SAR"),
      currency: "USD",
    });
    const plainUsd = fingerprintParams({ amount: "10.50", currency: "USD" });
    const plainSar = fingerprintParams({ amount: "10.50", currency: "SAR" });
    expect(nested).not.toBe(plainUsd);
    expect(nested).not.toBe(plainSar);
  });

  it("encodes NaN / Infinity distinctly from null and ordinary strings", () => {
    expect(fingerprintParams(Number.NaN)).not.toBe(fingerprintParams(null));
    expect(fingerprintParams(Number.POSITIVE_INFINITY)).not.toBe(
      fingerprintParams(null),
    );
    expect(fingerprintParams(Number.NEGATIVE_INFINITY)).not.toBe(
      fingerprintParams(null),
    );
    expect(fingerprintParams(Number.NaN)).not.toBe(
      fingerprintParams(Number.POSITIVE_INFINITY),
    );
    expect(fingerprintParams({ x: Number.NaN })).not.toBe(
      fingerprintParams({ x: null }),
    );
    // Type tags must not equal JSON string encodings of the same text.
    expect(fingerprintParams(Number.NaN)).not.toBe(fingerprintParams("NaN"));
    expect(fingerprintParams(Number.POSITIVE_INFINITY)).not.toBe(
      fingerprintParams("Infinity"),
    );
    expect(fingerprintParams(Number.NEGATIVE_INFINITY)).not.toBe(
      fingerprintParams("-Infinity"),
    );
    expect(fingerprintParams(undefined)).not.toBe(
      fingerprintParams("undefined"),
    );
    expect(fingerprintParams(undefined)).not.toBe(
      fingerprintParams("__undefined__"),
    );
  });

  it("fingerprints BigInt without throwing and without colliding with strings", () => {
    expect(fingerprintParams(10n)).toBe(fingerprintParams(10n));
    expect(fingerprintParams(10n)).not.toBe(fingerprintParams(11n));
    expect(fingerprintParams(10n)).not.toBe(fingerprintParams(10));
    expect(fingerprintParams(10n)).not.toBe(fingerprintParams("10n"));
    expect(fingerprintParams({ amount: 1050n })).toBe(
      fingerprintParams({ amount: 1050n }),
    );
    expect(fingerprintParams({ amount: 1050n })).not.toBe(
      fingerprintParams({ amount: "1050n" }),
    );
  });

  it("fingerprints Date as ISO-8601, not empty object", () => {
    const d = new Date("2026-01-15T12:00:00.000Z");
    expect(stableStringifyParams(d)).toBe(`__date__:${d.toISOString()}`);
    expect(fingerprintParams(d)).toBe(sha256Hex(stableStringifyParams(d)));
    expect(fingerprintParams(d)).not.toBe(fingerprintParams({}));
    expect(fingerprintParams({ at: d })).toBe(
      fingerprintParams({ at: new Date("2026-01-15T12:00:00.000Z") }),
    );
  });

  it("MONEY-2: Date fingerprint does not collide with the same ISO string", () => {
    const iso = "2026-01-15T12:00:00.000Z";
    const d = new Date(iso);
    expect(fingerprintParams(d)).not.toBe(fingerprintParams(iso));
    expect(fingerprintParams({ at: d })).not.toBe(fingerprintParams({ at: iso }));
  });

  it("includes Money.exponent so scale overrides do not false-match (MONEY-1)", () => {
    // money(10, USD, {exponent:0}) → 10 minors; amount:10 currency:USD → 1000 minors
    const override = money(10, "USD", { exponent: 0 });
    expect(override.exponent).toBe(0);
    expect(override.amount).toBe("10");

    const fpOverride = fingerprintParams({ amount: override, currency: "USD" });
    const fpPlain = fingerprintParams({ amount: 10, currency: "USD" });
    expect(fpOverride).not.toBe(fpPlain);

    // Pure Money with stored exponent also differs from ISO-scale equivalent.
    expect(fingerprintParams(override)).not.toBe(
      fingerprintParams(money(10, "USD")),
    );
    expect(fingerprintParams(override)).not.toBe(
      fingerprintParams({ amount: "10.00", currency: "USD" }),
    );

    // Economically identical ISO forms still match.
    expect(fingerprintParams(money("10.00", "USD"))).toBe(
      fingerprintParams({ amount: 10, currency: "USD" }),
    );
  });

  it("preserves sibling exponent on number/string amount bags (MONEY-1)", () => {
    // number bag with exponent:0 → 10 minors; bare ISO bag → 1000 minors
    const numberExp0 = fingerprintParams({
      amount: 10,
      currency: "USD",
      exponent: 0,
    });
    const numberIso = fingerprintParams({ amount: 10, currency: "USD" });
    expect(numberExp0).not.toBe(numberIso);

    // string bag with sibling exponent must not drop scale either
    const stringExp0 = fingerprintParams({
      amount: "10",
      currency: "USD",
      exponent: 0,
      orderId: "ord_scale",
    });
    const stringIso = fingerprintParams({
      amount: "10",
      currency: "USD",
      orderId: "ord_scale",
    });
    expect(stringExp0).not.toBe(stringIso);

    // number bag + exponent matches nested Money with same scale override
    expect(
      fingerprintParams({ amount: 10, currency: "USD", exponent: 0 }),
    ).toBe(
      fingerprintParams({
        amount: money(10, "USD", { exponent: 0 }),
        currency: "USD",
      }),
    );
  });

  it("persists a sha256 digest, not raw stringify (S19-FINGERPRINT)", () => {
    const params = { amount: 10, currency: "USD", orderId: "ord_1" };
    const fp = fingerprintParams(params);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toBe(stableStringifyParams(params));
    expect(fp).not.toContain("USD");
    expect(fp).not.toContain("ord_1");
    expect(fp).toBe(sha256Hex(stableStringifyParams(params)));
    expect(fp).toBe(
      fingerprintParams({ orderId: "ord_1", currency: "USD", amount: 10 }),
    );
  });

  it("hashes card-number leaves so Visa vs Mastercard do not collide (S20-FINGERPRINT-REDACT)", () => {
    const withVisa = {
      amount: 10,
      currency: "USD",
      cardNumber: "4111111111111111",
    };
    const withMc = {
      amount: 10,
      currency: "USD",
      cardNumber: "5555555555554444",
    };
    const fpVisa = fingerprintParams(withVisa);
    const fpMc = fingerprintParams(withMc);

    expect(fpVisa).toMatch(/^[0-9a-f]{64}$/);
    expect(fpVisa).not.toBe(fpMc);
    expect(fpVisa).not.toContain("4111111111111111");
    expect(fpMc).not.toContain("5555555555554444");
    // Raw PAN bags are not the stored identity (leaf is transformed).
    expect(fpVisa).not.toBe(sha256Hex(stableStringifyParams(withVisa)));
    expect(fpMc).not.toBe(sha256Hex(stableStringifyParams(withMc)));
  });

  it("does not collapse distinct billing / otp / gatewayPaymentId leaves (S20-FINGERPRINT-REDACT)", () => {
    const idA = "1234567890123";
    const idB = "9876543210987";
    const pairs = [
      [
        {
          paymobBillingData: {
            email: "a@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            phone: "0500000001",
          },
        },
        {
          paymobBillingData: {
            email: "b@example.com",
            firstName: "Grace",
            lastName: "Hopper",
            phone: "0500000002",
          },
        },
      ],
      [{ otpValue: "1111" }, { otpValue: "2222" }],
      [{ gatewayPaymentId: idA }, { gatewayPaymentId: idB }],
      [{ orderId: idA }, { orderId: idB }],
      [{ paymentId: idA }, { paymentId: idB }],
    ] as const;
    for (const [left, right] of pairs) {
      expect(fingerprintParams(left)).not.toBe(fingerprintParams(right));
    }
    // Allow-listed ids are not PAN-hashed; 13-digit values stay identity.
    expect(fingerprintParams({ gatewayPaymentId: idA })).toBe(
      sha256Hex(stableStringifyParams({ gatewayPaymentId: idA })),
    );
  });

  it("still collides economically identical money while hashing PII (S20-FINGERPRINT-REDACT)", () => {
    const collisions = [
      [
        { amount: "10.50", currency: "USD", email: "a@b.com" },
        { amount: 10.5, currency: "usd", email: "a@b.com" },
      ],
      [
        { amount: "10.500", currency: "USD" },
        { amount: "10.50", currency: "USD" },
      ],
    ] as const;
    for (const [left, right] of collisions) {
      expect(fingerprintParams(left)).toBe(fingerprintParams(right));
    }
  });

  it("C-R8-FINGERPRINT-MONEY-PAN: JPY 1e12 Money / string / number / trailing-zero share one SHA-256", () => {
    const expected = fingerprintParams(money(1e12, "JPY"));
    const variants = [
      { amount: "1000000000000", currency: "JPY" },
      { amount: 1_000_000_000_000, currency: "JPY" },
      { amount: "1000000000000.0", currency: "JPY" },
      { amount: money(1e12, "JPY"), currency: "JPY" },
    ];
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(expected).not.toContain("1000000000000");
    for (const variant of variants) {
      expect(fingerprintParams(variant)).toBe(expected);
    }
    expect(fingerprintParams({ amount: "1000000000001", currency: "JPY" })).not.toBe(
      expected,
    );
    // Amount without sibling currency is not money — still PAN-hash the leaf.
    expect(fingerprintParams({ amount: "1000000000000" })).not.toBe(
      sha256Hex(stableStringifyParams({ amount: "1000000000000" })),
    );
  });

  it("strips AbortSignal so caller signals are not identity", () => {
    const amount = { amount: 10, currency: "USD", orderId: "ord_sig" };
    const withSignal = {
      ...amount,
      signal: new AbortController().signal,
    };
    const otherSignal = {
      ...amount,
      signal: new AbortController().signal,
    };
    expect(fingerprintParams(withSignal)).toBe(fingerprintParams(amount));
    expect(fingerprintParams(withSignal)).toBe(fingerprintParams(otherSignal));
  });
});
