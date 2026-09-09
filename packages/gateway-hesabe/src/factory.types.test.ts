import {
  createPaymentClient,
  InMemoryIdempotencyStore,
  money,
  type CreatePaymentParams,
  type GatewayName,
} from "@paykernel/core";
import { hesabeGateway, type HesabeConfig, type HesabeGateway } from "./index";

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
