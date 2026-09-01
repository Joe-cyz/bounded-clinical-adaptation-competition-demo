import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { computeDraftDiff } from "@/domain/draft-revisions";
import { openRuntimeDatabase } from "./connection";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { createDraftRevisionRepository } from "./repositories/draft-revision-repository";

// SYNTHETIC_TEST_ONLY: runtime-built corruption marker avoids a public email-like literal.
const syntheticCorruptMarker = ["not-json-with-synthetic", "example.invalid"].join("@");
import { createGenerationRunRepository } from "./repositories/generation-run-repository";
import { fixtureDraftRevision, fixtureGenerationRun } from "./test-fixtures";

function expectPersistenceError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected persistence error.");
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe(code);
  }
}

describe("draft revision repository", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:" });
  });

  afterEach(() => {
    database.close();
  });

  function insertRun(id = "run-revision-repository") {
    createGenerationRunRepository(database).insert(fixtureGenerationRun({ id }));
  }

  it("appends, reads and lists immutable revision snapshots", () => {
    insertRun();
    const repository = createDraftRevisionRepository(database);
    const first = fixtureDraftRevision({ generationRunId: "run-revision-repository" });

    repository.append(first);
    const read = repository.getById(first.id);
    expect(read).toEqual(first);
    expect(repository.getLatestByGenerationRun(first.generationRunId)).toEqual(first);
    expect(repository.listByGenerationRun(first.generationRunId)).toEqual([first]);

    read!.afterSnapshot.sections[0].content[0] = "caller mutation only";
    expect(repository.getById(first.id)?.afterSnapshot.sections[0].content[0]).not.toBe("caller mutation only");
  });

  it("requires a continuous revision and expected previous version", () => {
    insertRun();
    const repository = createDraftRevisionRepository(database);
    const first = fixtureDraftRevision({ generationRunId: "run-revision-repository" });
    repository.append(first);

    const secondAfter = {
      ...first.afterSnapshot,
      sections: first.afterSnapshot.sections.map((section, index) => index === 1
        ? { ...section, content: [...section.content, "第二次编辑"] }
        : section),
    };
    const second = fixtureDraftRevision({
      id: "revision-fixture-002",
      generationRunId: first.generationRunId,
      revisionNumber: 2,
      beforeSnapshot: first.afterSnapshot,
      afterSnapshot: secondAfter,
      diffSummary: computeDraftDiff(first.afterSnapshot, secondAfter),
    });

    expectPersistenceError(() => repository.append(second, 0), persistenceErrorCodes.CONFLICT);
    expectPersistenceError(() => repository.append({ ...second, revisionNumber: 3 }, 1), persistenceErrorCodes.CONFLICT);
    repository.append(second, 1);
    const duplicateIdAfter = {
      ...second.afterSnapshot,
      sections: second.afterSnapshot.sections.map((section, index) => index === 2
        ? { ...section, content: [...section.content, "重复 ID 测试"] }
        : section),
    };
    const duplicateId = {
      ...second,
      revisionNumber: 3,
      beforeSnapshot: second.afterSnapshot,
      afterSnapshot: duplicateIdAfter,
      diffSummary: computeDraftDiff(second.afterSnapshot, duplicateIdAfter),
    };
    expectPersistenceError(() => repository.append(duplicateId, 2), persistenceErrorCodes.CONFLICT);
  });

  it("returns a redacted data corruption error for damaged JSON", () => {
    insertRun();
    const repository = createDraftRevisionRepository(database);
    const first = fixtureDraftRevision({ generationRunId: "run-revision-repository" });
    repository.append(first);
    const corruptJson = `{${syntheticCorruptMarker}}`;
    database.prepare("UPDATE draft_revisions SET after_json = ? WHERE id = ?").run(corruptJson, first.id);

    try {
      repository.getById(first.id);
      throw new Error("Expected data corruption rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain(corruptJson);
    }
  });

  it("reads legacy line-index-v1 revisions without rewriting them", () => {
    insertRun();
    const repository = createDraftRevisionRepository(database);
    const revision = fixtureDraftRevision({ generationRunId: "run-revision-repository" });
    const legacyDiff = {
      schemaVersion: "1.0.0",
      algorithmVersion: "line-index-v1",
      newlineNormalization: "CRLF_AND_CR_TO_LF",
      formulaVersion: "edit-burden-v1",
      orderChanged: false,
      beforeSectionOrder: revision.beforeSnapshot.sections.map((section) => section.key),
      afterSectionOrder: revision.afterSnapshot.sections.map((section) => section.key),
      changedSections: [{
        key: "summary",
        field: "content",
        lineChanges: [{ index: 0, before: "旧内容", after: "旧内容改写" }],
        addedLineCount: 1,
        removedLineCount: 1,
        addedCharacterCount: 5,
        removedCharacterCount: 3,
      }],
      metrics: {
        changedSectionCount: 1,
        addedLineCount: 1,
        removedLineCount: 1,
        addedCharacterCount: 5,
        removedCharacterCount: 3,
        editBurdenRatio: 0.5,
      },
    };
    database.prepare(`
      INSERT INTO draft_revisions (
        id, schema_version, generation_run_id, revision_number,
        before_json, after_json, diff_summary_json, editor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.id,
      revision.schemaVersion,
      revision.generationRunId,
      revision.revisionNumber,
      JSON.stringify(revision.beforeSnapshot),
      JSON.stringify(revision.afterSnapshot),
      JSON.stringify(legacyDiff),
      revision.editorId,
      revision.createdAt,
    );

    const read = repository.getById(revision.id);
    expect(read?.diffSummary.algorithmVersion).toBe("line-index-v1");
    expect((read?.diffSummary as { formulaVersion: string }).formulaVersion).toBe("edit-burden-v1");
  });

  it("blocks suspected PII without storing the value", () => {
    insertRun();
    const repository = createDraftRevisionRepository(database);
    const first = fixtureDraftRevision({ generationRunId: "run-revision-repository" });
    const after = {
      ...first.afterSnapshot,
      sections: first.afterSnapshot.sections.map((section, index) => index === 0
        ? { ...section, content: [...section.content, "姓名：合成患者"] }
        : section),
    };
    const piiRevision = {
      ...first,
      id: "revision-pii",
      afterSnapshot: after,
      diffSummary: computeDraftDiff(first.beforeSnapshot, after),
    };

    expectPersistenceError(() => repository.append(piiRevision), persistenceErrorCodes.SUSPECTED_PII);
    expect(repository.getById(piiRevision.id)).toBeUndefined();
    expect(JSON.stringify(piiRevision.id)).not.toContain("合成患者");
  });
});
