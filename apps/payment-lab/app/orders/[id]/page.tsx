import PaymentProgress from "@/src/components/payment-progress";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="eyebrow">Order</p>
        <h1 className="text-3xl font-semibold tracking-tight">Payment progress</h1>
        <p className="text-sm text-muted-foreground">Follow payment confirmation and order updates.</p>
      </div>
      <PaymentProgress orderId={id} />
      <div className="flex flex-wrap gap-4 text-sm">
        <a className="underline underline-offset-4" href="/">New checkout →</a>
        <a className="underline underline-offset-4" href="/seller">Seller controls →</a>
      </div>
    </div>
  );
}
