import { expect, it } from "bun:test";
import { isHesabeApplePayAction, isHesabeEmbeddedCheckoutAction } from "./index";

const embedded = { type: "hesabe_embedded_checkout", sessionId: "session", environment: "sandbox" };
const applePay = {
  type: "hesabe_apple_pay",
  checkoutToken: "session",
  environment: "production",
  scriptUrl: "https://api.hesabe.com/applepay?data=session",
};

it.each([
  { action: embedded, embedded: true, applePay: false },
  { action: applePay, embedded: false, applePay: true },
  ...[
    undefined,
    null,
    [],
    "session",
    {},
    { type: "redirect", url: "https://shop.example" },
    { ...embedded, sessionId: " " },
    { ...embedded, environment: "live" },
    { ...applePay, checkoutToken: 123 },
    { ...applePay, scriptUrl: "" },
    { ...applePay, environment: null },
  ].map((action) => ({ action, embedded: false, applePay: false })),
])("narrows only complete browser action shapes: $action", ({ action, embedded, applePay }) => {
  expect(isHesabeEmbeddedCheckoutAction(action)).toBe(embedded);
  expect(isHesabeApplePayAction(action)).toBe(applePay);
});
