import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import type { AppEnv } from "../env";
import { isTesterEmail } from "../env";
import { createAuth } from "./auth";
import { createDb } from "./db";
import { listGatewayReadiness } from "./gateways/index";
import { getOrderDetail, performPaymentAction, reconcileAttempt, startPayment, } from "./payment-service";
import { createOrder, editOrder, getOrder, listOrders, updateOrderFulfillment, updateOrderNotes, } from "./payments/orders";
import { listAttemptsByOrder } from "./payments/attempts";
import { readCheckout } from "./start-payment";
import { listTestRuns } from "./payments/testing";
import type { LabAttempt, LabOrder } from "./payments/types";
const GUEST_COOKIE = "pk_lab_guest";
const GATEWAY_VALUES = [
    "stripe",
    "paypal",
    "paymob",
    "moyasar",
    "tap",
    "myfatoorah",
    "hesabe",
] as const;
const CATALOG_SKU = "notebook";
const CATALOG_NAME = "Test notebook";
const CATALOG_PRICES_MINOR: Record<string, number> = {
    USD: 1000,
    EGP: 1000,
    SAR: 1000,
    KWD: 1000,
};
export type SanitizedOrder = Omit<LabOrder, "guestTokenHash">;
export type SanitizedAttempt = Omit<LabAttempt, "fingerprint">;
export type SellerSession = {
    id: string;
    email: string;
    name: string;
};
export type RequireSellerResult = {
    ok: true;
    user: SellerSession;
} | {
    ok: false;
    status: 401 | 403;
};
export async function requireSeller(env: AppEnv, request: Request): Promise<RequireSellerResult> {
    const db = env.DB;
    const auth = createAuth(env, createDb(db));
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
        return { ok: false, status: 401 };
    if (!isTesterEmail(env, session.user.email))
        return { ok: false, status: 403 };
    return {
        ok: true,
        user: { id: session.user.id, email: session.user.email, name: session.user.name },
    };
}
function sanitizeOrder(order: LabOrder): SanitizedOrder {
    return {
        id: order.id,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        totalMinor: order.totalMinor,
        currency: order.currency,
        items: order.items,
        fulfillment: order.fulfillment,
        notes: order.notes,
        version: order.version,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
    };
}
function sanitizeAttempt(attempt: LabAttempt): SanitizedAttempt {
    return {
        id: attempt.id,
        orderId: attempt.orderId,
        gateway: attempt.gateway,
        mode: attempt.mode,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        captureIntent: attempt.captureIntent,
        idempotencyKey: attempt.idempotencyKey,
        status: attempt.status,
        ambiguous: attempt.ambiguous,
        pendingOperationId: attempt.pendingOperationId,
        provider: attempt.provider,
        capturedMinor: attempt.capturedMinor,
        refundedMinor: attempt.refundedMinor,
        version: attempt.version,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
    };
}
function readGuestToken(c: Context<{ Bindings: AppEnv }>): string | undefined {
  const token = getCookie(c, GUEST_COOKIE);
  return token && /^[0-9a-f-]{36}$/i.test(token) ? token : undefined;
}

async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = new Uint8Array(digest);
    let out = "";
    for (const b of bytes)
        out += b.toString(16).padStart(2, "0");
    return out;
}
function guestSetCookie(token: string, env: AppEnv): string {
    const secure = new URL(env.APP_ORIGIN).protocol === "https:";
    const encoded = encodeURIComponent(token);
    let cookie = `${GUEST_COOKIE}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    if (secure)
        cookie += "; Secure";
    return cookie;
}
function csrfRejected(c: Context<{
    Bindings: AppEnv;
}>, env: AppEnv): boolean {
    const method = c.req.method.toUpperCase();
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE")
        return false;
    const origin = c.req.header("origin");
    if (!origin)
        return true;
    return origin !== env.APP_ORIGIN;
}
function zodJson<T>(schema: z.ZodType<T>) {
    return validator("json", (value, c) => {
        const contentType = c.req.header("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
            return c.json({ error: "Content-Type must be application/json." }, 400);
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            return c.json({ error: "Invalid request.", issues: parsed.error.issues }, 400);
        }
        return parsed.data;
    });
}
const createOrderSchema = z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(320),
    gateway: z.enum(GATEWAY_VALUES),
    quantity: z.number().int().min(1).max(5),
});
const paySchema = z.object({
    gateway: z.enum(GATEWAY_VALUES),
    mode: z.enum(["sandbox", "simulator"]),
    captureIntent: z.enum(["automatic", "manual"]),
    idempotencyKey: z.string().min(1).max(128),
    sourceToken: z.string().min(1).max(256).optional(),
    phone: z.string().min(5).max(32).optional(),
    method: z.string().min(1).max(128).optional(),
});
const patchOrderSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("notes"),
        expectedVersion: z.number().int().min(1),
        notes: z.string().max(2000),
    }),
    z.object({
        action: z.literal("fulfillment"),
        expectedVersion: z.number().int().min(1),
        fulfillment: z.enum([
            "unfulfilled",
            "processing",
            "shipped",
            "delivered",
            "cancelled",
        ]),
    }),
    z.object({
        action: z.literal("items"),
        expectedVersion: z.number().int().min(1),
        currency: z.string().regex(/^[A-Z]{3}$/),
        items: z
            .array(z.object({
            name: z.string().min(1).max(200),
            quantity: z.number().int().positive(),
            unitMinor: z.number().int().positive(),
            sku: z.string().min(1).max(128).optional(),
        }))
            .min(1)
            .max(100),
    }),
]);
const attemptActionSchema = z.object({
    kind: z.enum(["capture", "void", "refund"]),
    amountMinor: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(128),
});
async function isSellerBypass(env: AppEnv, c: Context<{
    Bindings: AppEnv;
}>): Promise<boolean> {
    const check = await requireSeller(env, c.req.raw);
    return check.ok;
}
export async function buyerScopeCheck(env: AppEnv, c: Context<{
    Bindings: AppEnv;
}>, orderId: string): Promise<{ order: LabOrder }> {
    const db = env.DB;
    let order: LabOrder;
    {
        order = await getOrder(db, orderId);
    }
    if (await isSellerBypass(env, c))
        return { order };
    const token = readGuestToken(c);
    if (!token)
        throw new HTTPException(404, { message: "Not found." });
    const hash = await sha256Hex(token);
    if (hash !== order.guestTokenHash)
        throw new HTTPException(404, { message: "Not found." });
    return { order };
}
export function createLabApi(env: AppEnv) {
    return new Hono<{
        Bindings: AppEnv;
    }>()
        .get("/api/gateways", async (c) => {
        {
            const gateways = await listGatewayReadiness(env);
            const publicConfig: {
                STRIPE_PUBLISHABLE_KEY?: string;
                MOYASAR_PUBLISHABLE_KEY?: string;
            } = {};
            if (typeof env.STRIPE_PUBLISHABLE_KEY === "string" &&
                env.STRIPE_PUBLISHABLE_KEY.length > 0) {
                publicConfig.STRIPE_PUBLISHABLE_KEY = env.STRIPE_PUBLISHABLE_KEY;
            }
            if (typeof env.MOYASAR_PUBLISHABLE_KEY === "string" &&
                env.MOYASAR_PUBLISHABLE_KEY.length > 0) {
                publicConfig.MOYASAR_PUBLISHABLE_KEY = env.MOYASAR_PUBLISHABLE_KEY;
            }
            return c.json({ gateways, publicConfig }, 200);
        }
    })
        .get("/api/catalog", (c) => {
        return c.json({
            items: [
                {
                    sku: CATALOG_SKU,
                    name: CATALOG_NAME,
                    pricesMinor: CATALOG_PRICES_MINOR,
                },
            ],
        }, 200);
    })
        .post("/api/orders", zodJson(createOrderSchema), async (c) => {
        if (csrfRejected(c, env)) {
            return c.json({ error: "Origin mismatch." }, 403);
        }
        {
            const body = c.req.valid("json");
            const readiness = await listGatewayReadiness(env);
            const entry = readiness.find((r) => r.gateway === body.gateway);
            if (!entry)
                return c.json({ error: "Unknown gateway." }, 400);
            const currency = entry.defaultCurrency;
            const unitMinor = CATALOG_PRICES_MINOR[currency];
            if (unitMinor === undefined) {
                return c.json({ error: `Currency ${currency} is not for sale.` }, 400);
            }
            const totalMinor = unitMinor * body.quantity;
            if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
                return c.json({ error: "Invalid total." }, 400);
            }
            let token = readGuestToken(c);
            let setCookie: string | null = null;
            if (!token) {
                token = crypto.randomUUID();
                setCookie = guestSetCookie(token, env);
            }
            const guestTokenHash = await sha256Hex(token);
            const db = env.DB;
            const order = await createOrder(db, {
                guestTokenHash,
                customerName: body.name,
                customerEmail: body.email,
                totalMinor,
                currency,
                items: [
                    {
                        sku: CATALOG_SKU,
                        name: CATALOG_NAME,
                        quantity: body.quantity,
                        unitMinor,
                    },
                ],
            });
            if (setCookie)
                c.header("Set-Cookie", setCookie);
            return c.json({ order: sanitizeOrder(order) }, 201);
        }
    })
        .get("/api/orders/:id", async (c) => {
        {
            const id = c.req.param("id");
            await buyerScopeCheck(env, c, id);

            const detail = await getOrderDetail(env, id);
            const attempts = await Promise.all(detail.attempts.map(async attempt => ({
                ...attempt,
                checkout: attempt.mode === "sandbox" && ["pending", "processing"].includes(attempt.status)
                    ? await readCheckout(env.DB, attempt.id) : {},
            })));
            return c.json({ ...detail, attempts, stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY }, 200);
        }
    })
        .post("/api/orders/:id/pay", zodJson(paySchema), async (c) => {
        if (csrfRejected(c, env)) {
            return c.json({ error: "Origin mismatch." }, 403);
        }
        {
            const id = c.req.param("id");
            await buyerScopeCheck(env, c, id);

            const body = c.req.valid("json");
            const result = await startPayment(env, id, {
                gateway: body.gateway,
                mode: body.mode,
                captureIntent: body.captureIntent,
                idempotencyKey: body.idempotencyKey,
                ...(body.sourceToken !== undefined
                    ? { sourceToken: body.sourceToken }
                    : {}),
                ...(body.phone !== undefined ? { phone: body.phone } : {}),
                ...(body.method !== undefined ? { method: body.method } : {}),
            });
            const attempt = sanitizeAttempt(result.attempt);
            return c.json({ attempt, checkout: result.checkout }, 201);
        }
    })
        .get("/api/seller/orders", async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        {
            const db = env.DB;
            const orders = await listOrders(db, 50);
            const summaries = await Promise.all(orders.map(async (order) => {
                const attempts = await listAttemptsByOrder(db, order.id);
                const latest = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
                return {
                    order: sanitizeOrder(order),
                    latestAttempt: latest === undefined ? null : sanitizeAttempt(latest),
                };
            }));
            return c.json({ orders: summaries }, 200);
        }
    })
        .get("/api/seller/orders/:id", async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        {
            const id = c.req.param("id");
            const detail = await getOrderDetail(env, id);
            return c.json(detail, 200);
        }
    })
        .patch("/api/seller/orders/:id", zodJson(patchOrderSchema), async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        if (csrfRejected(c, env)) {
            return c.json({ error: "Origin mismatch." }, 403);
        }
        {
            const id = c.req.param("id");
            const body = c.req.valid("json");
            const db = env.DB;
            if (body.action === "notes") {
                const order = await updateOrderNotes(db, {
                    orderId: id,
                    expectedVersion: body.expectedVersion,
                    notes: body.notes,
                });
                return c.json({ order: sanitizeOrder(order) }, 200);
            }
            if (body.action === "fulfillment") {
                const order = await updateOrderFulfillment(db, {
                    orderId: id,
                    expectedVersion: body.expectedVersion,
                    fulfillment: body.fulfillment,
                });
                return c.json({ order: sanitizeOrder(order) }, 200);
            }
            let totalMinor = 0;
            for (const item of body.items) {
                const line = item.quantity * item.unitMinor;
                if (!Number.isSafeInteger(line) || line <= 0) {
                    return c.json({ error: "Invalid line total." }, 400);
                }
                totalMinor += line;
                if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
                    return c.json({ error: "Invalid total." }, 400);
                }
            }
            const order = await editOrder(db, {
                orderId: id,
                expectedVersion: body.expectedVersion,
                totalMinor,
                currency: body.currency,
                items: body.items.map((item) => ({
                    name: item.name,
                    quantity: item.quantity,
                    unitMinor: item.unitMinor,
                    ...(item.sku !== undefined ? { sku: item.sku } : {}),
                })),
            });
            return c.json({ order: sanitizeOrder(order) }, 200);
        }
    })
        .post("/api/seller/attempts/:id/actions", zodJson(attemptActionSchema), async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        if (csrfRejected(c, env)) {
            return c.json({ error: "Origin mismatch." }, 403);
        }
        {
            const id = c.req.param("id");
            const body = c.req.valid("json");
            const result = await performPaymentAction(env, id, {
                kind: body.kind,
                ...(body.amountMinor !== undefined
                    ? { amountMinor: body.amountMinor }
                    : {}),
                idempotencyKey: body.idempotencyKey,
            });
            return c.json(result, 200);
        }
    })
        .post("/api/seller/attempts/:id/reconcile", async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        if (csrfRejected(c, env)) {
            return c.json({ error: "Origin mismatch." }, 403);
        }
        {
            const id = c.req.param("id");
            const result = await reconcileAttempt(env, id);
            return c.json(result, 200);
        }
    })
        .get("/api/seller/runs", async (c) => {
        const seller = await requireSeller(env, c.req.raw);
        if (!seller.ok) {
            if (seller.status === 401)
                return c.json({ error: "Sign in to continue." }, 401);
            return c.json({ error: "Seller access required." }, 403);
        }
        {
            const db = env.DB;
            const runs = await listTestRuns(db, 200);
            return c.json({ runs }, 200);
        }
    });
}
export type LabApiType = ReturnType<typeof createLabApi>;
