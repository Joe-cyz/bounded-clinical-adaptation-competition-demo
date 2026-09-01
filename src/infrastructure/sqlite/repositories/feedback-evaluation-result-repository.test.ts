import { runEvaluationBatch } from "@/application/evaluation-service";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createFeedbackEvaluationResultRepository } from "./feedback-evaluation-result-repository";
import { describe, expect, it } from "vitest";

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function idFactory() {
  let counter = 0;
  return (kind: string) => `${kind.toLowerCase()}-feedback-repository-${String(counter++).padStart(4, "0")}`;
}

describe("feedback evaluation result repository", () => {
  it("is append-only, queryable and redacts corrupt JSON errors", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const outcome = await runEvaluationBatch({ database, clock: fixedClock, idFactory: idFactory() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const repository = createFeedbackEvaluationResultRepository(database);
    const results = repository.listByBatch(outcome.batchId, 500);
    expect(results).toHaveLength(36);
    expect(repository.getById(results[0].id)).toEqual(results[0]);
    expect(repository.listByStatus("PASS", 500)).toHaveLength(36);
    expect(() => repository.append(results[0])).toThrow(PersistenceError);

    database.prepare("UPDATE feedback_evaluation_results SET observed_json = ? WHERE id = ?").run("{invalid", results[0].id);
    try {
      repository.getById(results[0].id);
      throw new Error("Expected corrupt feedback evaluation JSON.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain("{invalid");
    }
    database.close();
  });
});
