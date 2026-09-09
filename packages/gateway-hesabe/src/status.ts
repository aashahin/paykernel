import type { GatewayPaymentStatus } from "@paykernel/core";

function normalizeStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

/**
 * Transaction enquiry status mapping (exact verified contract):
 * SUCCESSFUL -> paid, FAILED -> failed, PENDING -> pending.
 * Unknown values stay conservative (caller returns indeterminate).
 */
export function mapHesabeEnquiryStatus(status: unknown): GatewayPaymentStatus | undefined {
  const key = normalizeStatus(status);
  if (key === "SUCCESSFUL") return "paid";
  if (key === "FAILED") return "failed";
  if (key === "PENDING") return "pending";
  return undefined;
}

/** Callback resultCode successes: CAPTURED / ACCEPT / SUCCESS. */
export function isHesabeCallbackSuccess(resultCode: unknown): boolean {
  const key = normalizeStatus(resultCode);
  return key === "CAPTURED" || key === "ACCEPT" || key === "SUCCESS";
}
