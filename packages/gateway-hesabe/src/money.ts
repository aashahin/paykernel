import { InvalidRequestError, money, normalizeAmountInput, type Money } from "@paykernel/core";

const KWD_OPTS = {
  rounding: "reject" as const,
  allowZero: false,
  allowNegative: false,
};

/**
 * Canonical KWD money for Hesabe. Rejects non-KWD currency, zero/negative
 * amounts, and excess precision (no silent rounding). KWD exponent is 3.
 */
export function toHesabeKwd(amount: Money, currency: string): Money {
  const normalized = normalizeAmountInput(amount, assertHesabeKwdCurrency(currency), KWD_OPTS);
  if (normalized.exponent !== undefined && normalized.exponent !== 3) {
    throw new InvalidRequestError("Hesabe requires the standard KWD exponent of 3");
  }
  return money(normalized.amount, "KWD", KWD_OPTS);
}

export function assertHesabeKwdCurrency(currency: unknown): string {
  if (typeof currency !== "string" || currency.trim().toUpperCase() !== "KWD") {
    throw new InvalidRequestError(`Hesabe only supports KWD (got "${String(currency)}")`);
  }
  return "KWD";
}

/** Strict KWD decimal string from provider JSON (number or string). */
export function parseHesabeKwdAmount(amount: unknown): Money {
  if (typeof amount === "number") {
    return money(amount, "KWD", KWD_OPTS);
  }
  if (typeof amount === "string") {
    const trimmed = amount.trim();
    if (trimmed.length === 0) {
      throw new InvalidRequestError("Hesabe amount must be a decimal string");
    }
    return money(trimmed, "KWD", KWD_OPTS);
  }
  throw new InvalidRequestError("Hesabe amount must be a number or decimal string");
}

/** Decimal KWD string for encrypted payloads (`"10.000"`). */
export function hesabeDecimalKwd(amount: Money): string {
  return toHesabeKwd(amount, amount.currency).amount;
}
