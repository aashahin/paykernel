import GatewaySetup from "@/src/components/gateway-setup";

export default function SetupPage() {
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <p className="text-sm font-medium text-muted-foreground">Setup</p>
        <h1 className="text-3xl font-semibold tracking-tight">Gateway setup</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">Read-only readiness per gateway. No credentials are entered here.</p>
      </div>
      <GatewaySetup />
    </div>
  );
}
