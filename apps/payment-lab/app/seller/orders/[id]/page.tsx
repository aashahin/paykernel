import { SellerAccess } from "@/src/components/seller-access";
import SellerOrderDetail from "@/src/components/seller-order-detail";

export default async function SellerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <SellerAccess>
      <div className="grid gap-1">
        <p className="eyebrow">Seller workspace</p>
        <h1 className="text-3xl font-semibold tracking-tight">Order detail</h1>
        <p className="text-sm text-muted-foreground">
          <a className="underline underline-offset-4" href="/seller">← Back to orders</a>
        </p>
      </div>
      <SellerOrderDetail orderId={id} />
    </SellerAccess>
  );
}
