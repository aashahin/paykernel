export function formatMinor(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat("en", { style: "currency", currency });
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** exponent);
}

export function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
}
