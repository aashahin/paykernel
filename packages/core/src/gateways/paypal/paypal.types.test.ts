/** PayPal F7 regression: createPayment must accept returnUrl on all 3 paths. */
import {
  createPaymentClient,
  paypalGateway,
  money,
  type GatewayPaymentResult,
} from "../../index";

/** Compile-time assignability assertion (erased at runtime). */
function expectType<T>(_value: T): void {}

// Default-configured PayPal client: single-arg facade must accept returnUrl.
const paypalDefaultClient = createPaymentClient({
  gateways: {
    paypal: paypalGateway({ clientId: "id", clientSecret: "sec", sandbox: true }),
  },
  defaultGateway: "paypal",
});

function _paypalCreatePaymentReturnUrlParity(
  client: typeof paypalDefaultClient,
): void {
  // Inline fresh literals are essential: a shared variable would bypass
  // excess-property checking and miss this regression.
  expectType<Promise<GatewayPaymentResult>>(
    client.createPayment(
      {
        amount: money("10", "USD"),
        currency: "USD",
        returnUrl: "https://merchant.example/return",
      },
      "paypal",
    ),
  );
  expectType<Promise<GatewayPaymentResult>>(
    client.createPayment({
      amount: money("10", "USD"),
      currency: "USD",
      returnUrl: "https://merchant.example/return",
    }),
  );
  expectType<Promise<GatewayPaymentResult>>(
    client.gateway("paypal").createPayment({
      amount: money("10", "USD"),
      currency: "USD",
      returnUrl: "https://merchant.example/return",
    }),
  );
}
void _paypalCreatePaymentReturnUrlParity;
