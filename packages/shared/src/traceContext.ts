/**
 * W3C trace context, small enough to share between the browser and the server.
 *
 * A client websocket carries its connection span's `traceparent` on the socket URL so the
 * environment can parent its own connection span on the client's. Both ends of a drop then land
 * in the server trace file under one trace id. This module holds the wire format only; it has no
 * platform dependencies so browser and React Native bundles can import it.
 */

/** Query parameter the client websocket URL uses to carry its connection span. */
export const TRACEPARENT_QUERY_PARAM = "traceparent";

export interface TraceParent {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

// version 00: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`.
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const ALL_ZERO_TRACE_ID = "0".repeat(32);
const ALL_ZERO_SPAN_ID = "0".repeat(16);

/** Renders a span's identity as a version-00 `traceparent` header value. */
export function formatTraceParent(input: TraceParent): string {
  return `00-${input.traceId}-${input.spanId}-${input.sampled ? "01" : "00"}`;
}

/**
 * Reads a version-00 `traceparent`. Returns undefined for anything malformed or all-zero, so a
 * client on a different version can never make the server parent a span on a bogus id.
 */
export function parseTraceParent(value: string | null | undefined): TraceParent | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
  if (match === null) {
    return undefined;
  }
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return undefined;
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}
