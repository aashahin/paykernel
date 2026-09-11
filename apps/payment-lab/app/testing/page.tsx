import { SellerAccess } from "@/src/components/seller-access";
import { TestingWorkspace } from "@/src/components/testing-workspace";

export default function TestingPage() {
  return (
    <SellerAccess>
      <div>
        <p className="eyebrow">Seller workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Scenario tests</h1>
        <p className="mt-2 text-sm text-muted-foreground">Run gateway scenarios in sandbox or simulator, then review history.</p>
      </div>
      <TestingWorkspace />
    </SellerAccess>
  );
}
