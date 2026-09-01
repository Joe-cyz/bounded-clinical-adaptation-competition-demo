import { describe, expect, it, vi } from "vitest";

import { createLiteratureSearchRouteHandlers } from "./literature-search-route";

function jsonHeaders(): Headers {
  return new Headers({
    Origin: "http://localhost:3000",
    Host: "localhost:3000",
    "Content-Type": "application/json",
  });
}

describe("literature search route", () => {
  it("rejects public-demo before reading the body or constructing a retrieval service", async () => {
    const bodyRead = vi.fn();
    const serviceFactory = vi.fn();
    const request = {
      headers: jsonHeaders(),
      get body(): ReadableStream<Uint8Array> {
        bodyRead();
        throw new Error("body must not be read");
      },
    } as unknown as Request;
    const response = await createLiteratureSearchRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "public-demo" },
      serviceFactory,
    }).post(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, errorCode: "PUBLIC_DEMO_READ_ONLY" });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("passes a bounded search request and exposes only citation DTOs", async () => {
    const service = { search: vi.fn(() => ({
      status: "INSUFFICIENT_EVIDENCE" as const,
      results: [],
    })) };
    const response = await createLiteratureSearchRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service as never,
    }).post(new Request("http://localhost:3000/api/literature/search", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ encounterId: "encounter-001", query: "合成资料", documentIds: ["document-001"] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "INSUFFICIENT_EVIDENCE", results: [] });
    expect(service.search).toHaveBeenCalledWith({ encounterId: "encounter-001", query: "合成资料", documentIds: ["document-001"] });
  });
});
