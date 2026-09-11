import { SellerAccess } from "@/src/components/seller-access";
import SellerOrders from "@/src/components/seller-orders";

export default function SellerPage() {
  return <SellerAccess>
    <div><p className="eyebrow">Seller workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Orders</h1></div>
    <SellerOrders />
  </SellerAccess>;
}
