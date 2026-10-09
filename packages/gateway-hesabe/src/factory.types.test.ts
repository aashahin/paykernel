import {
  createPaymentClient,
  InMemoryIdempotencyStore,
  money,
  type CreatePaymentParams,
  type GatewayName,
} from "@paykernel/core";
import {
  hesabeGateway,
  isHesabeApplePayAction,
  isHesabeEmbeddedCheckoutAction,
  type HesabeApplePayAction,
  type HesabeApplePayPaymentType,
  type HesabeCheckoutMode,
  type HesabeConfig,
  type HesabeCreatePaymentParams,
  type HesabeEmbeddedCheckoutAction,
  type HesabeEnquiryTransaction,
  type HesabeGateway,
  type HesabeTransactionEnquiryParams,
  type HesabeTransactionEnquiryResult,
} from "./index";

const config: HesabeConfig = {
  merchantCode: "test",
  accessCode: "test",
  encryptionKey: "a".repeat(32),
  ivKey: "b".repeat(16),
  username: "test",
  password: "test",
  idempotencyStore: new InMemoryIdempotencyStore(),
};
const client = createPaymentClient({
  gateways: { hesabe: hesabeGateway(config) },
  defaultGateway: "hesabe",
});
const gateway: HesabeGateway = client.gateway("hesabe");
void gateway;
function verifyProviderFields() {
  void client.createPayment({
    amount: money("10", "KWD"),
    currency: "KWD",
    callbackUrl: "https://shop.example",
    orderId: "order",
    idempotencyKey: "key",
    hesabeMobileNumber: "12345678",
  });
  const core: CreatePaymentParams = {
    amount: money("10", "KWD"),
    currency: "KWD",
    callbackUrl: "https://shop.example",
    // @ts-expect-error Hesabe fields stay out of core's common params.
    hesabeMobileNumber: "12345678",
  };
  void core;
  // @ts-expect-error An external adapter does not widen the built-in name union.
  const builtin: GatewayName = "hesabe";
  void builtin;
  // @ts-expect-error Atomic reservation storage is required configuration.
  const incomplete: HesabeConfig = {
    merchantCode: "test",
    accessCode: "test",
    encryptionKey: "a".repeat(32),
    ivKey: "b".repeat(16),
    username: "test",
    password: "test",
  };
  void incomplete;
  // @ts-expect-error Registry names remain inferred.
  client.gateway("stripe");
}
void verifyProviderFields;

function verifyTransactionEnquiryTypes() {
  const token: HesabeTransactionEnquiryParams = { token: "tx-1" };
  const order: HesabeTransactionEnquiryParams = {
    orderReferenceNumber: "order-1",
    signal: new AbortController().signal,
  };
  const result: Promise<HesabeTransactionEnquiryResult> = client
    .gateway("hesabe")
    .getTransactionEnquiry(token);
  void result;
  void gateway.getTransactionEnquiry(order);
  // @ts-expect-error A transaction enquiry requires one identifier.
  void gateway.getTransactionEnquiry({});
  // @ts-expect-error Token and order reference lookups are mutually exclusive.
  void gateway.getTransactionEnquiry({ token: "tx-1", orderReferenceNumber: "order-1" });
  // @ts-expect-error Provider lookup identifiers must be strings.
  void gateway.getTransactionEnquiry({ token: 123 });
  // @ts-expect-error Native transaction enquiry remains a Hesabe-specific API.
  void client.getTransactionEnquiry(token);
  void result.then((response) => {
    const accepted: true = response.status;
    const transaction: HesabeEnquiryTransaction = response.data;
    const amount: string = transaction.amount;
    const nativeStatus: string = transaction.status;
    const id: number | null | undefined = transaction.Id;
    const card: string | null | undefined = transaction.customerCard;
    const attempts: HesabeEnquiryTransaction[] | undefined = response.results;
    void [accepted, amount, nativeStatus, id, card, attempts];
  });
}
void verifyTransactionEnquiryTypes;

async function verifyCheckoutModes() {
  const base = {
    amount: money("10", "KWD"),
    currency: "KWD",
    callbackUrl: "https://shop.example/callback",
    orderId: "order",
    idempotencyKey: "checkout-order",
  };
  const mode: HesabeCheckoutMode = "embedded";
  const paymentType: HesabeApplePayPaymentType = 11;
  const params: HesabeCreatePaymentParams = {
    ...base,
    hesabeCheckoutMode: "applepay",
    hesabeApplePayDomain: "shop.example",
    hesabeApplePayPaymentType: paymentType,
  };
  void client.createPayment({ ...base, hesabeCheckoutMode: mode, hesabeVariable5: "custom" });
  void client.createPayment(params, "hesabe");
  void gateway.createPayment(params);
  const result = await client.createPayment(params);
  if (isHesabeApplePayAction(result.nextAction)) {
    const action: HesabeApplePayAction = result.nextAction;
    const token: string = action.checkoutToken;
    const script: string = action.scriptUrl;
    void [token, script];
  }
  if (isHesabeEmbeddedCheckoutAction(result.nextAction)) {
    const action: HesabeEmbeddedCheckoutAction = result.nextAction;
    const session: string = action.sessionId;
    const environment: "sandbox" | "production" = action.environment;
    void [session, environment];
  }
  // @ts-expect-error Direct Apple Pay must identify its merchant domain.
  void client.createPayment({ ...base, hesabeCheckoutMode: "applepay" });
  // @ts-expect-error Apple Pay options cannot silently fall back to redirect mode.
  void gateway.createPayment({ ...base, hesabeApplePayDomain: "shop.example" });
  const embeddedWithApplePayType = {
    ...base,
    hesabeCheckoutMode: "embedded",
    hesabeApplePayPaymentType: 9,
  } as const;
  // @ts-expect-error Embedded checkout does not accept direct Apple Pay types.
  void client.createPayment(embeddedWithApplePayType);
  // @ts-expect-error Provider type 15 is a subscription, not Apple Pay.
  void gateway.createPayment({ ...params, hesabeApplePayPaymentType: 15 });
  // @ts-expect-error Direct Apple Pay reserves variable5 for its domain.
  void client.createPayment({ ...params, hesabeVariable5: "custom" }, "hesabe");
  // @ts-expect-error Checkout modes stay out of core's common input.
  const core: CreatePaymentParams = { ...base, hesabeCheckoutMode: "embedded" };
  void core;
}
void verifyCheckoutModes;
