import { expect, test } from "@playwright/test";

test("Moyasar token id starts checkout without sending card details to the lab", async ({ page }) => {
  const token = "token_sandbox_browser_fixture";
  let paymentBody: Record<string, unknown> | undefined;
  await page.route("**/api/gateways", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const gateway = data.gateways.find((item: { gateway: string }) => item.gateway === "moyasar");
    gateway.configured = true;
    data.publicConfig.MOYASAR_PUBLISHABLE_KEY = "pk_test_browser_fixture";
    await route.fulfill({ response, json: data });
  });
  await page.route("https://api.moyasar.com/v1/tokens", route => route.fulfill({
    status: 201, json: { id: token, status: "save_only", message: null },
  }));
  await page.route("**/api/orders", route => route.fulfill({ status: 201, json: { order: { id: "ord_moyasar_fixture" } } }));
  await page.route("**/api/orders/ord_moyasar_fixture/pay", async route => {
    paymentBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { attempt: { id: "att_moyasar_fixture" }, checkout: {} } });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Moyasar", exact: true }).click();
  await page.getByLabel("Mode", { exact: true }).click();
  await page.getByRole("option", { name: "sandbox", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Sandbox Buyer");
  await page.getByLabel("Email", { exact: true }).fill("buyer@example.com");
  await page.getByLabel("Cardholder", { exact: true }).fill("Sandbox Buyer");
  await page.getByLabel("Card number", { exact: true }).fill("4111111111111111");
  await page.getByLabel("Month", { exact: true }).fill("12");
  await page.getByLabel("Year", { exact: true }).fill("2030");
  await page.getByLabel("CVC", { exact: true }).fill("123");
  await page.getByRole("button", { name: "Tokenize and pay", exact: true }).click();
  await expect.poll(() => paymentBody?.sourceToken).toBe(token);
  expect(paymentBody).toMatchObject({ gateway: "moyasar", mode: "sandbox" });
  expect(paymentBody).not.toHaveProperty("number");
  expect(paymentBody).not.toHaveProperty("cvc");
  expect(JSON.stringify(paymentBody)).not.toContain("4111111111111111");
  await expect(page.getByLabel("Card number", { exact: true })).toHaveValue("");
});
