import {
  createGatewayRegistry,
  createPaymentClient,
  money,
  type PaymentClient,
} from "@paykernel/core";
import { tapGateway, type TapGateway } from "./index";

const client = createPaymentClient({
  gateways: {
    tap: tapGateway({ secretKey: "sk_test_types" }),
  },
  defaultGateway: "tap",
});

const gateway: TapGateway = client.gateway("tap");
void gateway;

type InferredClient = typeof client extends PaymentClient<infer _M, infer D>
  ? D
  : never;
const _inferredDefaultIsTap: InferredClient extends "tap"
  ? "tap" extends InferredClient
    ? true
    : false
  : false = true;
void _inferredDefaultIsTap;

function _assignTapCreateLiteral() {
  void gateway.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
}
void _assignTapCreateLiteral;

function _assignTapCreateViaClientFacade() {
  void client.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
  void client.createPayment(
    {
      amount: money("10.00", "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    },
    "tap",
  );
}
void _assignTapCreateViaClientFacade;

function _assignTapCreateViaSingletonWithoutDefaultGateway() {
  const singleton = createPaymentClient({
    gateways: {
      tap: tapGateway({ secretKey: "sk_test_types" }),
    },
  });
  void singleton.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
}
void _assignTapCreateViaSingletonWithoutDefaultGateway;

function _assignTapCreateViaRegistryFacade() {
  const registryClient = createPaymentClient({
    registry: createGatewayRegistry()
      .register(tapGateway({ secretKey: "sk_test_types" }))
      .build(),
    defaultGateway: "tap",
  });
  void registryClient.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
}
void _assignTapCreateViaRegistryFacade;

function _rejectTapCustomerOnCoreParams(legacy: PaymentClient): void {
  void legacy.createPayment({
    amount: money("10.00", "USD"),
    currency: "USD",
    callbackUrl: "https://merchant.example/callback",
    // @ts-expect-error tapCustomer is not on core CreatePaymentParams
    tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
}
void _rejectTapCustomerOnCoreParams;

function _rejectInlineCustomerWithoutLastName() {
  void gateway.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    // @ts-expect-error inline tapCustomer requires lastName
    tapCustomer: { firstName: "Ada", email: "ada@example.com" },
  });
}
void _rejectInlineCustomerWithoutLastName;

type RegisteredName = Parameters<typeof client.gateway>[0];
const _onlyTap: RegisteredName = "tap";
void _onlyTap;

// @ts-expect-error unknown name is not in the inferred map
const _stripe: RegisteredName = "stripe";
void _stripe;
