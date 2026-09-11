import {
  createGatewayRegistry,
  createPaymentClient,
  money,
  type PaymentClient,
} from "@paykernel/core";
import { myfatoorahGateway, type MyFatoorahGateway } from "./index";

const client = createPaymentClient({
  gateways: {
    myfatoorah: myfatoorahGateway({
      apiToken: "test_secret_myfatoorah_api_token",
      country: "KWT",
    }),
  },
  defaultGateway: "myfatoorah",
});

const gateway: MyFatoorahGateway = client.gateway("myfatoorah");
void gateway;

type InferredClient = typeof client extends PaymentClient<infer _M, infer D> ? D : never;
const _inferredDefaultIsMyfatoorah: InferredClient extends "myfatoorah"
  ? "myfatoorah" extends InferredClient
    ? true
    : false
  : false = true;
void _inferredDefaultIsMyfatoorah;

function _assignMyfatoorahCreateLiteral() {
  void gateway.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    idempotencyKey: "idem-1",
    myfatoorahCustomer: { name: "Ada", email: "ada@example.com" },
  });
}
void _assignMyfatoorahCreateLiteral;

function _assignMyfatoorahCreateViaClientFacade() {
  void client.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    idempotencyKey: "idem-1",
    myfatoorahCustomer: { name: "Ada", email: "ada@example.com" },
  });
  void client.createPayment(
    {
      amount: money("10.00", "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "idem-1",
      myfatoorahPaymentMethod: "KNET",
    },
    "myfatoorah",
  );
}
void _assignMyfatoorahCreateViaClientFacade;

function _assignMyfatoorahCreateViaSingletonWithoutDefaultGateway() {
  const singleton = createPaymentClient({
    gateways: {
      myfatoorah: myfatoorahGateway({
        apiToken: "test_secret_myfatoorah_api_token",
        country: "KWT",
      }),
    },
  });
  void singleton.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    idempotencyKey: "idem-1",
    myfatoorahCustomer: { name: "Ada", email: "ada@example.com" },
  });
}
void _assignMyfatoorahCreateViaSingletonWithoutDefaultGateway;

function _assignMyfatoorahCreateViaRegistryFacade() {
  const registryClient = createPaymentClient({
    registry: createGatewayRegistry()
      .register(
        myfatoorahGateway({
          apiToken: "test_secret_myfatoorah_api_token",
          country: "KWT",
        }),
      )
      .build(),
    defaultGateway: "myfatoorah",
  });
  void registryClient.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    idempotencyKey: "idem-1",
    myfatoorahPaymentMethod: "CARD",
  });
}
void _assignMyfatoorahCreateViaRegistryFacade;

function _rejectMyfatoorahCustomerOnCoreParams(legacy: PaymentClient): void {
  void legacy.createPayment({
    amount: money("10.00", "USD"),
    currency: "USD",
    callbackUrl: "https://merchant.example/callback",
    // @ts-expect-error myfatoorahCustomer is not on core CreatePaymentParams
    myfatoorahCustomer: { name: "Ada" },
  });
}
void _rejectMyfatoorahCustomerOnCoreParams;

function _rejectUnknownPaymentMethod() {
  void gateway.createPayment({
    amount: money("10.00", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    // @ts-expect-error lowercase / unknown methods are not in the union
    myfatoorahPaymentMethod: "knet",
  });
}
void _rejectUnknownPaymentMethod;

type RegisteredName = Parameters<typeof client.gateway>[0];
const _onlyMyfatoorah: RegisteredName = "myfatoorah";
void _onlyMyfatoorah;

// @ts-expect-error unknown name is not in the inferred map
const _stripe: RegisteredName = "stripe";
void _stripe;
