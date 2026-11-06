import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const manageInstabox = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:instabox:manage",
  tag: WS_METHODS.instaboxManage,
});

export const manageBoat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:boat:manage",
  tag: WS_METHODS.boatManage,
});
