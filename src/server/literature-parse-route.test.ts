import { describe, expect, it, vi } from "vitest";

import { createLiteratureParseRouteHandlers } from "./literature-parse-route";

function jsonHeaders(): Headers {
  return new Headers({
    Origin: "http://localhost:3000",
    Host: "localhost:3000",
    "Content-Type": "application/json",
  });
}

describe("literature parse route", () => {
  it("rejects public-demo before reading the request body or constructing a service", async () => {
    const bodyRead = vi.fn();
    const serviceFactory = vi.fn();
    const request = {
      headers: jsonHeaders(),
      get body(): ReadableStream<Uint8Array> {
        bodyRead();
        throw new Error("body must not be read");
      },
    } as unknown as Request;
    const response = await createLiteratureParseRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "public-demo" },
      serviceFactory,
    }).post(request, "synthetic-document-001");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, errorCode: "PUBLIC_DEMO_READ_ONLY" });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("passes only the document id and bounded JSON to the service, returning a safe result DTO", async () => {
    const service = {
      parseCurrentDocument: vi.fn(async () => ({
        idempotencyResult: "CREATED" as const,
        parseRun: {
          status: "READY" as const,
          parseRunId: "hidden-run",
          documentId: "hidden-document",
        },
      })),
    };
    const response = await createLiteratureParseRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service as never,
    }).post(new Request("http://localhost:3000/api/literature/documents/synthetic-document-001/parse", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ parseRequestId: "parse-route-001" }),
    }), "synthetic-document-001");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, idempotencyResult: "CREATED", parseStatus: "READY" });
    expect(service.parseCurrentDocument).toHaveBeenCalledWith({
      documentId: "synthetic-document-001",
      request: { parseRequestId: "parse-route-001" },
    });
  });
});
