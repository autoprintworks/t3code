import { describe, expect, it } from "vite-plus/test";

import { formatTraceParent, parseTraceParent } from "./traceContext.ts";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";

describe("traceContext", () => {
  it("round-trips a sampled and an unsampled span", () => {
    expect(formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-01`,
    );
    expect(parseTraceParent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: true,
    });
    expect(
      parseTraceParent(formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false })),
    ).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false });
  });

  it("accepts upper case and surrounding whitespace", () => {
    expect(parseTraceParent(` 00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-00 `)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      sampled: false,
    });
  });

  it("rejects anything the environment must not parent a span on", () => {
    const rejected = [
      undefined,
      null,
      "",
      "nonsense",
      // A future version: its trailing members are not ours to interpret.
      `01-${TRACE_ID}-${SPAN_ID}-01`,
      // All-zero ids are the spec's "no parent" value.
      `00-${"0".repeat(32)}-${SPAN_ID}-01`,
      `00-${TRACE_ID}-${"0".repeat(16)}-01`,
      // Wrong lengths and non-hex characters.
      `00-${TRACE_ID}-0123456789abcde-01`,
      `00-${TRACE_ID}-0123456789abcdeg-01`,
      `00-${TRACE_ID}-${SPAN_ID}`,
    ];
    for (const value of rejected) {
      expect(parseTraceParent(value)).toBeUndefined();
    }
  });
});
