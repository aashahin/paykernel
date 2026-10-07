import {
  createPaymentClient,
  InMemoryIdempotencyStore,
  money,
  type CreatePaymentParams,
  type GatewayName,
} from "@paykernel/core";
import {
  hesabeGateway,
  type HesabeConfig,
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
