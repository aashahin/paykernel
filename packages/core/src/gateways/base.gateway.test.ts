/**
 * BaseGateway post-submit indeterminate identity (CORE-7 / P22-IND-LOOKUP).
 */
import { describe, it, expect } from "bun:test";
import { BaseGateway } from "./base.gateway";
import { HooksManager } from "../hooks/hooks.manager";
import { InvalidRequestError, NetworkError } from "../errors";
import type {
  CreatePaymentParams,
  CaptureParams,
  RefundParams,
  GatewayPaymentResult,
  GatewayRefundResult,
} from "../types/payment.types";
import {
  applyIndeterminatePaymentMethodOutcome,
  type AttachPaymentMethodParams,
  type CreateCustomerParams,
  type CustomerOperationResult,
  type DetachPaymentMethodParams,
  type GetCustomerParams,
  type PaymentMethodOperationResult,
} from "../types/customer.types";
import type {
  DisputeOperationResult,
  GetDisputeParams,
  SubmitDisputeEvidenceParams,
} from "../types/dispute.types";
import type {
  CreatePaymentLinkParams,
  DeactivatePaymentLinkParams,
  PaymentLinkOperationResult,
} from "../types/payment-link.types";
import type { WebhookEvent } from "../types/webhook.types";

class TestGateway extends BaseGateway {
  readonly name = "test";
  failWith: Error | undefined;

  constructor(hooks: HooksManager = new HooksManager()) {
    super({}, hooks, undefined, {
      payments: true,
      immediateCapture: true,
      refunds: true,
      voids: true,
      hostedCheckout: true,
      customers: true,
      paymentMethods: true,
      disputes: true,
      paymentLinks: true,
    });
  }

  async createPayment(
    params: CreatePaymentParams,
  ): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        success: true,
        gatewayId: "pay_ok",
        status: "paid",
        redirectUrl: undefined,
        rawResponse: {},
      };
    });
  }

  async capturePayment(
    params: CaptureParams,
  ): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        success: true,
        gatewayId: params.gatewayPaymentId,
        status: "paid",
        redirectUrl: undefined,
        rawResponse: {},
      };
    });
  }

  async refundPayment(params: RefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        success: true,
        gatewayRefundId: "re_ok",
        status: "completed" as const,
        rawResponse: {},
      };
    });
  }

  async voidPayment(params: { gatewayPaymentId: string }): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("voidPayment", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        success: true,
        gatewayId: params.gatewayPaymentId,
        status: "cancelled",
        redirectUrl: undefined,
        rawResponse: {},
      };
    });
  }

  async confirmStcPayOtp(params: {
    transactionUrl: string;
    otpValue: string;
  }): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("confirmStcPayOtp", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        success: true,
        gatewayId: "pay_otp",
        status: "paid",
        redirectUrl: undefined,
        rawResponse: {},
      };
    });
  }

  async createCheckoutSession(params: {
    successUrl: string;
    amount?: number;
    currency?: string;
    idempotencyKey?: string;
  }) {
    return this.executeWithHooks("createCheckoutSession", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        session: {
          status: "open" as const,
          url: "https://checkout.test/pay",
          references: {
            providerObjectId: "cs_ok",
            normalizedStatus: "open",
            gateway: this.name,
          },
          rawResponse: {},
        },
      };
    });
  }

  async getCheckoutSession(params: { sessionId: string }) {
    return this.executeWithHooks("getCheckoutSession", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        session: {
          status: "open" as const,
          references: {
            providerObjectId: params.sessionId,
            normalizedStatus: "open",
            gateway: this.name,
          },
          paymentStatus: "unpaid",
          rawResponse: {},
        },
      };
    });
  }

  async createCustomer(
    params: CreateCustomerParams,
  ): Promise<CustomerOperationResult> {
    return this.executeWithHooks("createCustomer", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        customer: {
          status: "active" as const,
          references: {
            providerObjectId: "cus_ok",
            normalizedStatus: "active",
            gateway: this.name,
          },
        },
      };
    });
  }

  async getCustomer(params: GetCustomerParams): Promise<CustomerOperationResult> {
    return this.executeWithHooks("getCustomer", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        customer: {
          status: "active" as const,
          references: {
            providerObjectId: params.customerId,
            normalizedStatus: "active",
            gateway: this.name,
          },
        },
      };
    });
  }

  async attachPaymentMethod(
    params: AttachPaymentMethodParams,
  ): Promise<PaymentMethodOperationResult> {
    return this.executeWithHooks("attachPaymentMethod", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        paymentMethod: {
          id: params.paymentMethodId ?? "pm_ok",
          customerId: params.customerId,
          type: "card" as const,
          references: {
            providerObjectId: params.paymentMethodId ?? "pm_ok",
            normalizedStatus: "active",
            gateway: this.name,
          },
        },
      };
    });
  }

  async detachPaymentMethod(
    params: DetachPaymentMethodParams,
  ): Promise<PaymentMethodOperationResult> {
    return this.executeWithHooks("detachPaymentMethod", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        paymentMethod: {
          id: params.paymentMethodId,
          customerId: params.customerId ?? "unknown",
          type: "card" as const,
          references: {
            providerObjectId: params.paymentMethodId,
            normalizedStatus: "active",
            gateway: this.name,
          },
        },
      };
    });
  }

  async submitDisputeEvidence(
    params: SubmitDisputeEvidenceParams,
  ): Promise<DisputeOperationResult> {
    return this.executeWithHooks("submitDisputeEvidence", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        dispute: {
          status: "under_review",
          references: {
            providerObjectId: params.disputeId,
            normalizedStatus: "under_review",
            gateway: this.name,
          },
        },
      };
    });
  }

  async getDispute(params: GetDisputeParams): Promise<DisputeOperationResult> {
    return this.executeWithHooks("getDispute", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        dispute: {
          status: "needs_response",
          references: {
            providerObjectId: params.disputeId,
            normalizedStatus: "needs_response",
            gateway: this.name,
          },
        },
      };
    });
  }

  async createPaymentLink(
    params: CreatePaymentLinkParams,
  ): Promise<PaymentLinkOperationResult> {
    return this.executeWithHooks("createPaymentLink", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        paymentLink: {
          status: "active" as const,
          url: "https://checkout.test/link",
          references: {
            providerObjectId: "plink_ok",
            normalizedStatus: "active",
            gateway: this.name,
          },
        },
      };
    });
  }

  async deactivatePaymentLink(
    params: DeactivatePaymentLinkParams,
  ): Promise<PaymentLinkOperationResult> {
    return this.executeWithHooks("deactivatePaymentLink", params, async () => {
      if (this.failWith) throw this.failWith;
      return {
        outcome: "succeeded" as const,
        paymentLink: {
          status: "inactive" as const,
          url: "https://checkout.test/link",
          references: {
            providerObjectId: params.paymentLinkId,
            normalizedStatus: "inactive",
            gateway: this.name,
          },
        },
      };
    });
  }

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhookEvent(): WebhookEvent {
    throw new Error("not used");
  }
}

function postSubmitTimeout(): NetworkError {
  return new NetworkError("timed out after 30000ms", undefined, {
    afterProviderSubmit: true,
  });
}

describe("BaseGateway CORE-7 post-submit identity", () => {
  const createBase = {
    amount: 10,
    currency: "USD",
    callbackUrl: "https://example.test/return",
  };

  it.each([
    {
      label: "create uses orderId when present",
      run: (gw: TestGateway) =>
        gw.createPayment({ ...createBase, orderId: "ord_123" }),
      gatewayId: "ord_123",
    },
    {
      label: "create prefers orderId over idempotencyKey",
      run: (gw: TestGateway) =>
        gw.createPayment({
          ...createBase,
          orderId: "ord_wins",
          idempotencyKey: "idem_ignored",
        }),
      gatewayId: "ord_wins",
    },
    {
      label: "create uses idempotencyKey when no order/payment id exists",
      run: (gw: TestGateway) =>
        gw.createPayment({
          ...createBase,
          idempotencyKey: "idem_moyasar_given_id",
        }),
      gatewayId: "idem_moyasar_given_id",
    },
    {
      label: "OTP uses transactionUrl",
      run: (gw: TestGateway) =>
        gw.confirmStcPayOtp({
          transactionUrl: "https://moyasar.test/otp/txn_99",
          otpValue: "1234",
        }),
      gatewayId: "https://moyasar.test/otp/txn_99",
    },
    {
      label: "create without identity stays unknown",
      run: (gw: TestGateway) => gw.createPayment(createBase),
      gatewayId: "unknown",
    },
    {
      label: "capture uses gatewayPaymentId",
      run: (gw: TestGateway) =>
        gw.capturePayment({ gatewayPaymentId: "pi_cap_1" }),
      gatewayId: "pi_cap_1",
    },
    {
      label: "void uses gatewayPaymentId",
      run: (gw: TestGateway) =>
        gw.voidPayment({ gatewayPaymentId: "pi_void_1" }),
      gatewayId: "pi_void_1",
    },
  ])("post-submit timeout $label", async ({ run, gatewayId }) => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await run(gw);
    expect(result.outcome).toBe("indeterminate");
    expect(result.gatewayId).toBe(gatewayId);
    expect(result.reconciliationRequired).toBe(true);
  });

  it("refund post-submit timeout is indeterminate with gatewayRefundId", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.refundPayment({
      gatewayPaymentId: "pi_ref_1",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.gatewayRefundId).toBe("pi_ref_1");
    expect(result.reconciliationRequired).toBe(true);
  });

  it("pre-submit network error is not forged as indeterminate", async () => {
    const gw = new TestGateway();
    gw.failWith = new NetworkError("connect reset");
    await expect(gw.createPayment(createBase)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("S19-CKO-TIMEOUT: createCheckoutSession POST timeout is checkout-shaped indeterminate, not a retryable failed-create", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.createCheckoutSession({
      successUrl: "https://example.test/success",
      amount: 10,
      currency: "USD",
      idempotencyKey: "idem_cko_timeout",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.session?.references.providerObjectId).toBe("idem_cko_timeout");
    expect(result.session?.status).not.toBe("open");
    expect(result).not.toEqual(
      expect.objectContaining({ status: "processing" }),
    );
    expect(result).not.toEqual(
      expect.objectContaining({ gatewayId: "idem_cko_timeout" }),
    );
    expect(result).not.toEqual(
      expect.objectContaining({ sessionId: "idem_cko_timeout" }),
    );
  });

  it("S19-CKO-TIMEOUT: getCheckoutSession stays throwing on afterProviderSubmit NetworkError", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    await expect(
      gw.getCheckoutSession({ sessionId: "cs_get_timeout" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("P22-IND-LOOKUP: createCustomer POST timeout is customer-shaped indeterminate with lookup identity", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.createCustomer({
      email: "buyer@example.com",
      idempotencyKey: "idem_cus_timeout",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.message).toBe("timed out after 30000ms");
    expect(result.customer?.status).toBe("unknown");
    expect(result.customer?.status).not.toBe("active");
    expect(result.customer?.references.providerObjectId).toBe("idem_cus_timeout");
    expect(result).not.toEqual(expect.objectContaining({ status: "active" }));
  });

  it("P22-IND-LOOKUP: createCustomer timeout without identity stays unknown", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.createCustomer({ email: "buyer@example.com" });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.customer?.references.providerObjectId).toBe("unknown");
    expect(result.customer?.status).toBe("unknown");
  });

  it("P22-IND-LOOKUP: attachPaymentMethod timeout uses providerObjectIdFromParams lookup", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.attachPaymentMethod({
      customerId: "cus_lookup",
      paymentMethodId: "pm_1",
      idempotencyKey: "idem_pm_attach",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.message).toBe("timed out after 30000ms");
    expect(result.paymentMethod?.references.providerObjectId).toBe("pm_1");
    expect(result.paymentMethod?.id).toBe("pm_1");
    expect(result.paymentMethod?.customerId).toBe("cus_lookup");
    expect(result.paymentMethod?.references.normalizedStatus).toBe("unknown");
    expect(result.paymentMethod?.references.normalizedStatus).not.toBe("active");
  });

  it("P22-IND-LOOKUP: detachPaymentMethod timeout snapshots paymentMethod lookup id", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.detachPaymentMethod({
      paymentMethodId: "pm_detach_1",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.paymentMethod?.references.providerObjectId).toBe("pm_detach_1");
    expect(result.paymentMethod?.id).toBe("pm_detach_1");
    expect(result.paymentMethod?.customerId).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        result.paymentMethod ?? {},
        "customerId",
      ),
    ).toBe(false);
    expect(result.paymentMethod?.customerId).not.toBe("unknown");
    expect(result.paymentMethod?.references.normalizedStatus).not.toBe("active");
  });

  it("P22R3-DETACH-IND: detach timeout omits request customerId", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.detachPaymentMethod({
      paymentMethodId: "pm_detach_2",
      customerId: "cus_should_omit",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.paymentMethod?.customerId).toBeUndefined();
    expect(
      result.paymentMethod?.references.relatedIds?.customerId,
    ).toBeUndefined();
  });

  it("P22-IND-LOOKUP: submitDisputeEvidence timeout is dispute-shaped unknown, not open/won", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.submitDisputeEvidence({
      disputeId: "dp_ev_1",
      evidence: { uncategorizedText: "receipt on file" },
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.message).toBe("timed out after 30000ms");
    expect(result.dispute?.references.providerObjectId).toBe("dp_ev_1");
    expect(result.dispute?.status).toBe("unknown");
    expect(result.dispute?.status).not.toBe("needs_response");
    expect(result.dispute?.status).not.toBe("under_review");
  });

  it("P22-IND-LOOKUP: getDispute stays throwing on afterProviderSubmit NetworkError", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    await expect(gw.getDispute({ disputeId: "dp_get_1" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("P22-IND-LOOKUP: createPaymentLink timeout uses idempotencyKey lookup and does not invent active", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.createPaymentLink({
      amount: 10,
      currency: "USD",
      idempotencyKey: "idem_plink_timeout",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.message).toBe("timed out after 30000ms");
    expect(result.paymentLink?.references.providerObjectId).toBe(
      "idem_plink_timeout",
    );
    expect(result.paymentLink?.status).toBe("unknown");
    expect(result.paymentLink?.status).not.toBe("active");
    expect(result.paymentLink?.url).toBeUndefined();
  });

  it("P22-IND-LOOKUP: deactivatePaymentLink timeout uses paymentLinkId lookup", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    const result = await gw.deactivatePaymentLink({
      paymentLinkId: "plink_deact_1",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.paymentLink?.references.providerObjectId).toBe("plink_deact_1");
    expect(result.paymentLink?.status).toBe("unknown");
    expect(result.paymentLink?.status).not.toBe("inactive");
  });

  it("P22-IND-LOOKUP: getCustomer stays throwing on afterProviderSubmit NetworkError", async () => {
    const gw = new TestGateway();
    gw.failWith = postSubmitTimeout();
    await expect(
      gw.getCustomer({ customerId: "cus_get_1" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("P22-IND-LOOKUP: before-hooks cannot inject raw card material past executeWithHooks", async () => {
    const hooks = new HooksManager({
      onBefore: (ctx) => ({
        proceed: true,
        params: {
          ...(ctx.params as object),
          cardNumber: "4242424242424242",
        },
      }),
    });
    const gw = new TestGateway(hooks);
    await expect(
      gw.attachPaymentMethod({
        customerId: "cus_1",
        paymentMethodId: "pm_1",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("P22R3-IND-UNKNOWN-CUS: applyIndeterminatePaymentMethodOutcome omits missing/empty customerId", () => {
    const missing = applyIndeterminatePaymentMethodOutcome({
      paymentMethodId: "pm_lookup",
      message: "timeout",
      errorName: "NetworkError",
      gateway: "test",
    });
    expect(missing.paymentMethod?.id).toBe("pm_lookup");
    expect(missing.paymentMethod?.customerId).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(
        missing.paymentMethod ?? {},
        "customerId",
      ),
    ).toBe(false);
    expect(missing.paymentMethod?.customerId).not.toBe("unknown");

    const empty = applyIndeterminatePaymentMethodOutcome({
      paymentMethodId: "pm_lookup",
      customerId: "",
      message: "timeout",
      errorName: "NetworkError",
      gateway: "test",
    });
    expect(empty.paymentMethod?.id).toBe("pm_lookup");
    expect(empty.paymentMethod?.customerId).toBeUndefined();
    expect(empty.paymentMethod?.customerId).not.toBe("unknown");
  });

  it("P22R3-PCI-HOOK-ORDER: inbound PAN is rejected before before-hooks run", async () => {
    let beforeRan = false;
    const hooks = new HooksManager({
      onBefore: () => {
        beforeRan = true;
        return { proceed: true };
      },
    });
    const gw = new TestGateway(hooks);
    await expect(
      gw.attachPaymentMethod({
        customerId: "cus_1",
        paymentMethodId: "4242424242424242",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(beforeRan).toBe(false);
  });

  it("P22-PCI: before-hooks cannot inject metadata PAN on createPayment", async () => {
    const hooks = new HooksManager({
      onBefore: (ctx) => ({
        proceed: true,
        params: {
          ...(ctx.params as object),
          metadata: { pan: "4242424242424242" },
        },
      }),
    });
    const gw = new TestGateway(hooks);
    await expect(
      gw.createPayment({
        amount: 10,
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
