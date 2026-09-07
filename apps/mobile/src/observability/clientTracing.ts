import { installClientTracing } from "@t3tools/client-runtime/observability";
import Constants from "expo-constants";
import { Platform } from "react-native";

// The exporter itself lives in client-runtime so web, desktop and mobile all export their
// connection spans the same way; see packages/client-runtime/src/observability/clientTracing.ts.
// All this surface owns is how it names itself in the trace and which `fetch` it hands over.
installClientTracing({
  resource: {
    serviceName: "t3-mobile",
    attributes: {
      "service.runtime": "t3-mobile",
      "service.mode": Platform.OS,
      "service.version": Constants.expoConfig?.version ?? "unknown",
    },
  },
  fetch: (input, init) => globalThis.fetch(input, init),
});

export { ClientTracingLive } from "@t3tools/client-runtime/observability";
