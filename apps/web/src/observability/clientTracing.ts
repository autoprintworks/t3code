import { installClientTracing } from "@t3tools/client-runtime/observability";

import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

// The exporter itself lives in client-runtime so web, desktop and mobile all export their
// connection spans the same way; see packages/client-runtime/src/observability/clientTracing.ts.
// All this surface owns is how it names itself in the trace and which `fetch` it hands over.
installClientTracing({
  resource: {
    serviceName: "t3-web",
    attributes: {
      "service.runtime": "t3-web",
      "service.mode": isElectron ? "electron" : "browser",
      "service.version": APP_VERSION,
    },
  },
  fetch: (input, init) => globalThis.fetch(input, init),
});

export { ClientTracingLive } from "@t3tools/client-runtime/observability";
