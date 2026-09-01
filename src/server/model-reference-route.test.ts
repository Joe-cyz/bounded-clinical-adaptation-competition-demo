import { describe, expect, it, vi } from "vitest";

import { createModelReferenceRouteHandlers } from "./model-reference-route";

// SYNTHETIC_TEST_ONLY: construct a placeholder at runtime to avoid secret-scanner false positives.
const syntheticTestOnlyKey = ["s", "k"].join("") + "-" + "x".repeat(24);

describe("PWR-08C model reference route", () => {
  it("rejects public-demo before body parsing, database factory, or fake provider construction", async () => {
    const body = vi.fn(async () => { throw new Error("body must not be read"); });
    const serviceFactory = vi.fn(() => { throw new Error("service must not be constructed"); });
    const databaseFactory = vi.fn(() => { throw new Error("database must not be opened"); });
    const realProviderFactory = vi.fn(() => { throw new Error("provider must not be constructed"); });
    const handlers = createModelReferenceRouteHandlers({
      env: { APP_RUNTIME_MODE: "public-demo" },
      serviceFactory,
      databaseFactory,
      realProviderFactory,
    });
    const response = await handlers.post({
      headers: new Headers({ Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" }),
      body: { getReader: body },
    } as unknown as Request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, errorCode: "PUBLIC_DEMO_READ_ONLY" });
    expect(body).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(realProviderFactory).not.toHaveBeenCalled();
  });

  it("does not access an API key while enforcing the public gate", async () => {
    const env = new Proxy({ APP_RUNTIME_MODE: "public-demo" }, {
      get(target, property, receiver) {
        if (property === "DEEPSEEK_API_KEY") throw new Error("key access is forbidden");
        return Reflect.get(target, property, receiver);
      },
    });
    const handlers = createModelReferenceRouteHandlers({ env });
    const response = await handlers.post(new Request("http://localhost:3000/api/reference/model", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
  });

  it("does not read a key or construct a real Provider before a disabled gate", async () => {
    const env = new Proxy({
      APP_RUNTIME_MODE: "local-research",
      PWR08D_REAL_PROVIDER_ENABLED: "false",
      PWR08D_REAL_REQUEST_LIMIT: "0",
    }, {
      get(target, property, receiver) {
        if (property === "DEEPSEEK_API_KEY") throw new Error("key access is forbidden");
        return Reflect.get(target, property, receiver);
      },
    });
    const realProviderFactory = vi.fn();
    const handlers = createModelReferenceRouteHandlers({ env, realProviderFactory });
    const response = await handlers.post(new Request("http://localhost:3000/api/reference/model", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(realProviderFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["bad key", "not-a-key", "MODEL_REFERENCE_REAL_PROVIDER_CREDENTIAL_INVALID"],
    ["bad limit", syntheticTestOnlyKey, "MODEL_REFERENCE_REAL_PROVIDER_REQUEST_LIMIT_INVALID"],
  ] as const)("rejects real construction for %s", async (_label, value, expectedRule) => {
    const env = {
      APP_RUNTIME_MODE: "local-research",
      PWR08D_REAL_PROVIDER_ENABLED: "true",
      PWR08D_REAL_REQUEST_LIMIT: _label === "bad limit" ? "3" : "1",
      DEEPSEEK_API_KEY: _label === "bad key" ? value : syntheticTestOnlyKey,
    };
    const realProviderFactory = vi.fn();
    const handlers = createModelReferenceRouteHandlers({ env, realProviderFactory });
    const response = await handlers.post(new Request("http://localhost:3000/api/reference/model", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, errorCode: expectedRule });
    expect(realProviderFactory).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid real flag instead of silently using fake transport", async () => {
    const handlers = createModelReferenceRouteHandlers({
      env: {
        APP_RUNTIME_MODE: "local-research",
        PWR08C_FAKE_FETCH: "true",
        PWR08D_REAL_PROVIDER_ENABLED: "yes",
        PWR08D_REAL_REQUEST_LIMIT: "1",
      },
    });
    const response = await handlers.post(new Request("http://localhost:3000/api/reference/model", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, errorCode: "MODEL_REFERENCE_REAL_PROVIDER_ENABLE_FLAG_INVALID" });
  });
});
