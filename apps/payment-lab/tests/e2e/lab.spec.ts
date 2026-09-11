import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("guest isolation and seller access are enforced", async ({ request, baseURL, playwright }) => {
  const orderResponse = await request.post("/api/orders", { headers: { origin: baseURL! }, data: { name: "Guest buyer", email: "buyer@example.com", gateway: "stripe", quantity: 1 } });
  expect(orderResponse.status()).toBe(201);
  const { order } = await orderResponse.json();
  expect((await request.get(`/api/orders/${order.id}`)).status()).toBe(200);
  const other = await playwright.request.newContext({ baseURL: baseURL! });
  expect((await other.get(`/api/orders/${order.id}`)).status()).toBe(404);
  expect((await other.get("/api/seller/orders")).status()).toBe(401);
  expect((await other.post("/api/orders", { data: { name: "Forgery", email: "buyer@example.com", gateway: "stripe", quantity: 1 } })).status()).toBe(403);
  await other.dispose();
});

test("seven gateways settle simulator payments and refunds through signed HTTP", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const passwordPath = process.env.PAYKERNEL_TEST_PASSWORD_FILE;
  if (!passwordPath) throw new Error("PAYKERNEL_TEST_PASSWORD_FILE is required for seller E2E tests.");
  await page.goto("/seller");
  await page.getByLabel("Email", { exact: true }).fill(process.env.PAYKERNEL_TEST_EMAIL ?? "lab-tester@example.com");
  await page.getByLabel("Password", { exact: true }).fill((await readFile(passwordPath, "utf8")).trim());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const request: APIRequestContext = page.request;
  const headers = { origin: baseURL! };
  const gateways = ["stripe", "paypal", "paymob", "moyasar", "tap", "myfatoorah", "hesabe"];
  for (const gateway of gateways) {
    const orderResponse = await request.post("/api/orders", { headers, data: { name: `E2E ${gateway}`, email: "buyer@example.com", gateway, quantity: 1 } });
    expect(orderResponse.status()).toBe(201);
    const { order } = await orderResponse.json();
    const key = crypto.randomUUID();
    const pay = { gateway, mode: "simulator", captureIntent: "automatic", idempotencyKey: key };
    const payment = await request.post(`/api/orders/${order.id}/pay`, { headers, data: pay });
    expect(payment.status(), await payment.text()).toBe(201);
    const { attempt } = await payment.json();
    expect(attempt.ambiguous).toBe(false);
    const replay = await request.post(`/api/orders/${order.id}/pay`, { headers, data: pay });
    expect((await replay.json()).attempt.id).toBe(attempt.id);
    const settled = await request.post(`/api/seller/simulator/${attempt.id}`, { headers, data: { kind: "payment", outcome: "paid", deliver: true } });
    expect(settled.status(), await settled.text()).toBe(200);
    const settlement = await settled.json();
    expect(settlement.delivery.ok, JSON.stringify(settlement)).toBe(true);
    expect(settlement.attempt.status).toBe("paid");
    const refund = await request.post(`/api/seller/attempts/${attempt.id}/actions`, { headers, data: { kind: "refund", amountMinor: 400, idempotencyKey: crypto.randomUUID() } });
    expect(refund.status(), await refund.text()).toBe(200);
    const pending = await (await request.get(`/api/seller/orders/${order.id}`)).json();
    expect(pending.attempts[0].refundedMinor).toBe(0);
    const refundId = pending.attempts[0].refunds[0].providerRefundId;
    const refundSettled = await request.post(`/api/seller/simulator/${attempt.id}`, { headers, data: { kind: "refund", refundId, outcome: "completed", deliver: true } });
    expect(refundSettled.status(), await refundSettled.text()).toBe(200);
    const final = await (await request.get(`/api/seller/orders/${order.id}`)).json();
    expect(final.attempts[0].refundedMinor).toBe(400);
    expect(final.attempts[0].status).toBe("partially_refunded");
    expect(final.attempts[0].ambiguous).toBe(false);
    expect(final.attempts[0].webhooks).toHaveLength(2);
    await page.goto(`/seller/orders/${order.id}`);
    await expect(page.getByText("Partially refunded", { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: "test-results/seller-order.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Partially refunded", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/seller-order-mobile.png", fullPage: true });
});

test("mobile buyer can create an order and return to its durable progress", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("tab", { name: "PayPal", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Mobile buyer");
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.com");
  await page.getByRole("button", { name: "Create order and pay", exact: true }).click();
  await expect(page.getByText("Your simulated payment is ready for a tester to complete.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/buyer-mobile.png", fullPage: true });
  await page.getByRole("link", { name: "View payment progress", exact: true }).click();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
