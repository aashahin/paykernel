import { expect, test } from "@playwright/test";

test("checkout exposes all seven gateways", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(7);
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
});

test("seller page requires sign-in", async ({ page }) => {
  await page.goto("/seller");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
});

test("health checks D1 with SELECT 1", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  const json = (await res.json()) as { ok: boolean; db: boolean };
  expect(json.ok).toBe(true);
  expect(json.db).toBe(true);
});

test("session starts unauthenticated; seller ping is guarded", async ({ request }) => {
  const session = await request.get("/api/session");
  expect(session.ok()).toBeTruthy();
  const sessionJson = (await session.json()) as { authenticated: boolean };
  expect(sessionJson.authenticated).toBe(false);

  const ping = await request.get("/api/seller/ping");
  expect(ping.status()).toBe(401);
});
