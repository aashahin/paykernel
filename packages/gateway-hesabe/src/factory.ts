import {
  paymentRuntimeFromContext,
  type GatewayAdapter,
  type GatewayContext,
} from "@paykernel/core";
import { HESABE_ADAPTER_VERSION, HESABE_CAPABILITIES } from "./capabilities";
import { copyHesabeConfig, type HesabeConfig } from "./config";
import { HesabeGateway } from "./gateway";

/** Register Hesabe with credentials kept in the factory closure. */
export function hesabeGateway(config: HesabeConfig): GatewayAdapter<"hesabe", HesabeGateway> {
  const closed = copyHesabeConfig(config);
  return {
    name: "hesabe",
    manifest: {
      name: "hesabe",
      displayName: "Hesabe",
      version: HESABE_ADAPTER_VERSION,
      apiVersion: "2.0",
      capabilities: HESABE_CAPABILITIES,
    },
    create(context: GatewayContext) {
      return new HesabeGateway(
        closed,
        context.hooks,
        context.logger,
        paymentRuntimeFromContext(context),
      );
    },
  };
}
