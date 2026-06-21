import { describe, expect, it } from "vitest";
import { apiLogFields, errorCode, workerJobLogFields } from "../src/services/operationLogs.js";

describe("operation log helpers", () => {
  it("maps status and explicit errors to stable codes", () => {
    expect(errorCode({ code: "CUSTOM_CODE" })).toBe("CUSTOM_CODE");
    expect(errorCode({ statusCode: 403 })).toBe("FORBIDDEN");
    expect(errorCode({ status: 500 })).toBe("INTERNAL_ERROR");
    expect(errorCode(new Error("boom"))).toBe("OPERATION_ERROR");
  });

  it("adds API correlation fields", () => {
    const fields = apiLogFields(
      {
        id: "request-1",
        url: "/api/jobs/11111111-1111-4111-8111-111111111111",
        params: { id: "11111111-1111-4111-8111-111111111111" },
        routeOptions: { url: "/api/jobs/:id" }
      } as any,
      { statusCode: 404 } as any,
      Date.now()
    );

    expect(fields).toMatchObject({
      requestId: "request-1",
      jobId: "11111111-1111-4111-8111-111111111111",
      action: "/api/jobs/:id",
      status: 404,
      errorCode: "NOT_FOUND"
    });
    expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("adds worker job correlation fields", () => {
    const fields = workerJobLogFields({
      id: "22222222-2222-4222-8222-222222222222",
      hostId: "33333333-3333-4333-8333-333333333333",
      type: "host.sync"
    }, "failed", Date.now(), { statusCode: 409 });

    expect(fields).toMatchObject({
      jobId: "22222222-2222-4222-8222-222222222222",
      hostId: "33333333-3333-4333-8333-333333333333",
      action: "host.sync",
      status: "failed",
      errorCode: "CONFLICT"
    });
  });
});
