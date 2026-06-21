import { describe, expect, it } from "vitest";
import { consumeAgentSseChunk } from "../src/services/agent.js";

describe("agent log stream parsing", () => {
  it("parses chunked SSE frames without trimming JSON log values", () => {
    const buffer = { value: "" };
    const events: Array<{ event: string; data: string }> = [];
    const input = [
      'data: {"line":"  leading and trailing  "}\n\n',
      'data: {"line":""}\n\n',
      'event: error\n',
      'data: {"error":"boom"}\n\n'
    ].join("");

    consumeAgentSseChunk(buffer, Buffer.from(input.slice(0, 20)), (event, data) => events.push({ event, data }));
    consumeAgentSseChunk(buffer, Buffer.from(input.slice(20)), (event, data) => events.push({ event, data }));

    expect(JSON.parse(events[0]!.data)).toEqual({ line: "  leading and trailing  " });
    expect(JSON.parse(events[1]!.data)).toEqual({ line: "" });
    expect(events[2]).toMatchObject({ event: "error" });
  });
});
