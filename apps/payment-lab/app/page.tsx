import Checkout from "@/src/components/checkout";

export default function HomePage() {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="eyebrow">Checkout</p>
        <h1 className="text-3xl font-semibold tracking-tight">Test notebook checkout</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose a gateway and try a complete payment workflow.
        </p>
      </div>
      <Checkout />
    </div>
  );
}
