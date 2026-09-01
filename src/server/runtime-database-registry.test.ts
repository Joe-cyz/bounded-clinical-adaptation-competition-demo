import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { getOrCreateRuntimeDatabase } from "./runtime-database-registry";

describe("runtime database registry", () => {
  it("shares one database handle for the same runtime key", () => {
    const cacheKey = `test:${randomUUID()}`;
    const createDatabase = vi.fn(() => new DatabaseSync(":memory:"));
    const first = getOrCreateRuntimeDatabase(cacheKey, createDatabase);

    try {
      const second = getOrCreateRuntimeDatabase(cacheKey, createDatabase);
      expect(second).toBe(first);
      expect(createDatabase).toHaveBeenCalledOnce();
    } finally {
      first.close();
    }
  });

  it("keeps different runtime keys isolated", () => {
    const first = getOrCreateRuntimeDatabase(
      `test:${randomUUID()}`,
      () => new DatabaseSync(":memory:"),
    );
    const second = getOrCreateRuntimeDatabase(
      `test:${randomUUID()}`,
      () => new DatabaseSync(":memory:"),
    );

    try {
      expect(second).not.toBe(first);
    } finally {
      first.close();
      second.close();
    }
  });
});
