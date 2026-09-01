import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { PersistenceError, persistenceErrorCodes } from "./errors";
import { openRuntimeDatabase } from "./connection";
import {
  getCurrentSchemaVersion,
  migrationChecksum,
  runMigrations,
  runtimeMigrations,
  validateRuntimeSchemaBase,
} from "./migrations";

const fixedMigrationTime = "2026-08-19T00:00:00.000Z";

const testV11Migration = {
  version: 13,
  name: "0013_add_runtime_marker",
  sql: "ALTER TABLE generation_runs ADD COLUMN runtime_marker TEXT;",
  validateStructure(database: DatabaseSync) {
    validateRuntimeSchemaBase(database, false);
    const columns = database.prepare("PRAGMA table_info(\"generation_runs\")").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "runtime_marker")) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Test v11 structure is incomplete.",
      );
    }
  },
} as const;

function expectPersistenceError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected persistence error.");
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe(code);
  }
}

describe("SQLite runtime migrations", () => {
  it("creates the complete schema and enables required pragmas", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);

    const tableRows = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tableRows.map((row) => row.name)).toEqual([
      "audit_events",
      "draft_revisions",
      "encounter_record_revisions",
      "encounters",
      "evaluation_batches",
      "evaluation_results",
      "evaluation_runs",
      "feedback_evaluation_results",
      "feedback_events",
      "generation_runs",
      "literature_document_versions",
      "literature_documents",
      "literature_fragments",
      "literature_fragments_fts",
      "literature_fragments_fts_config",
      "literature_fragments_fts_content",
      "literature_fragments_fts_data",
      "literature_fragments_fts_docsize",
      "literature_fragments_fts_idx",
      "literature_import_batches",
      "literature_import_items",
      "literature_pages",
      "literature_parse_runs",
      "manual_synthetic_intakes",
      "model_reference_followups",
      "model_reference_items",
      "model_reference_runs",
      "model_reference_supports",
      "physician_confirmations",
      "physician_profile_versions",
      "pre_sign_reviews",
      "review_decisions",
      "review_item_decisions",
      "schema_migrations",
    ]);

    database.close();
  });

  it("creates the Encounter workflow and literature import storage foundation", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect((database.prepare("PRAGMA table_info(\"encounters\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual([
        "id",
        "schema_version",
        "synthetic",
        "case_id",
        "case_version",
        "status",
        "demographic_snapshot_json",
        "current_record_revision_id",
        "created_at",
        "updated_at",
        "confirmed_at",
        "runtime_mode",
        "source_type",
        "manual_intake_id",
      ]);
    expect((database.prepare("PRAGMA table_info(\"encounter_record_revisions\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual([
        "id",
        "encounter_id",
        "schema_version",
        "revision_number",
        "record_payload_json",
        "created_at",
      ]);
    expect((database.prepare("PRAGMA index_list(\"encounters\")").all() as Array<{ name: string }>).map((index) => index.name))
      .toEqual(expect.arrayContaining([
        "idx_encounters_status_updated",
        "idx_encounters_case_created",
        "idx_encounters_runtime_status",
      ]));
    expect(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('literature_import_batches', 'literature_import_items', 'literature_documents', 'literature_document_versions') LIMIT 1",
    ).get()).toEqual({ 1: 1 });
    expect((database.prepare("PRAGMA table_info(\"literature_import_items\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["detected_format", "detected_mime"]));
    expect((database.prepare("PRAGMA index_list(\"literature_import_items\")").all() as Array<{ name: string; unique: number }>).some((index) => index.name === "ux_literature_import_items_active_sha256" && index.unique === 1)).toBe(true);
    database.close();
  });

  it("rejects current-version trigger counterexamples including version number, document binding and missing version", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    const insertBatchAndItem = (batchId: string, itemId: string, sha: string) => {
      database.prepare(`
        INSERT INTO literature_import_batches (
          batch_id, schema_version, request_id, request_fingerprint, status,
          expected_file_count, expected_total_bytes, received_file_count, received_total_bytes,
          source_type, permission_scope, created_at, updated_at, completed_at, failure_code
        ) VALUES (?, '1.0.0', ?, ?, 'COMPLETED', 1, 12, 1, 12, 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, ?, NULL)
      `).run(batchId, `${batchId}-request`, sha, fixedMigrationTime, fixedMigrationTime, fixedMigrationTime);
      database.prepare(`
        INSERT INTO literature_import_items (
          item_id, batch_id, schema_version, client_file_id, intent, document_id,
          expected_current_version, original_filename, declared_extension, declared_mime,
          expected_size_bytes, status, actual_size_bytes, actual_sha256, storage_key,
          detected_format, detected_mime, failure_code, created_at, updated_at, completed_at
        ) VALUES (?, ?, '1.0.0', ?, 'CREATE_DOCUMENT', NULL, NULL, 'trigger.pdf', '.pdf', 'application/pdf', 12, 'AVAILABLE', 12, ?, ?, 'PDF', 'application/pdf', NULL, ?, ?, ?)
      `).run(itemId, batchId, `${itemId}-client`, sha, `objects/${sha.slice(0, 2)}/${sha}.pdf`, fixedMigrationTime, fixedMigrationTime, fixedMigrationTime);
    };

    const shaOne = "a".repeat(64);
    const shaTwo = "b".repeat(64);
    insertBatchAndItem("batch-trigger-001", "item-trigger-001", shaOne);
    database.exec("BEGIN");
    database.prepare(`
      INSERT INTO literature_document_versions (
        version_id, document_id, version_number, schema_version, format, original_filename,
        declared_mime, detected_mime, size_bytes, sha256, storage_key, import_batch_id,
        import_item_id, created_at
      ) VALUES ('version-trigger-001', 'document-trigger-001', 1, '1.0.0', 'PDF', 'trigger.pdf', 'application/pdf', 'application/pdf', 12, ?, ?, 'batch-trigger-001', 'item-trigger-001', ?)
    `).run(shaOne, `objects/${shaOne.slice(0, 2)}/${shaOne}.pdf`, fixedMigrationTime);
    database.prepare(`
      INSERT INTO literature_documents (
        document_id, schema_version, status, display_name, current_version, current_version_id,
        source_type, permission_scope, created_at, updated_at, disabled_at
      ) VALUES ('document-trigger-001', '1.0.0', 'ACTIVE', 'trigger.pdf', 1, 'version-trigger-001', 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, NULL)
    `).run(fixedMigrationTime, fixedMigrationTime);
    database.exec("COMMIT");

    expect(() => database.prepare(`
      INSERT INTO literature_documents (
        document_id, schema_version, status, display_name, current_version, current_version_id,
        source_type, permission_scope, created_at, updated_at, disabled_at
      ) VALUES ('document-trigger-mismatch', '1.0.0', 'ACTIVE', 'trigger.pdf', 2, 'version-trigger-001', 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, NULL)
    `).run(fixedMigrationTime, fixedMigrationTime)).toThrow();

    insertBatchAndItem("batch-trigger-002", "item-trigger-002", shaTwo);
    database.exec("BEGIN");
    database.prepare(`
      INSERT INTO literature_document_versions (
        version_id, document_id, version_number, schema_version, format, original_filename,
        declared_mime, detected_mime, size_bytes, sha256, storage_key, import_batch_id,
        import_item_id, created_at
      ) VALUES ('version-trigger-002', 'document-trigger-002', 1, '1.0.0', 'PDF', 'trigger.pdf', 'application/pdf', 'application/pdf', 12, ?, ?, 'batch-trigger-002', 'item-trigger-002', ?)
    `).run(shaTwo, `objects/${shaTwo.slice(0, 2)}/${shaTwo}.pdf`, fixedMigrationTime);
    database.prepare(`
      INSERT INTO literature_documents (
        document_id, schema_version, status, display_name, current_version, current_version_id,
        source_type, permission_scope, created_at, updated_at, disabled_at
      ) VALUES ('document-trigger-002', '1.0.0', 'ACTIVE', 'trigger.pdf', 1, 'version-trigger-002', 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, NULL)
    `).run(fixedMigrationTime, fixedMigrationTime);
    database.exec("COMMIT");
    expect(() => database.prepare(`
      INSERT INTO literature_documents (
        document_id, schema_version, status, display_name, current_version, current_version_id,
        source_type, permission_scope, created_at, updated_at, disabled_at
      ) VALUES ('document-trigger-other', '1.0.0', 'ACTIVE', 'trigger.pdf', 1, 'version-trigger-002', 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, NULL)
    `).run(fixedMigrationTime, fixedMigrationTime)).toThrow();
    expect(() => database.prepare(`
      INSERT INTO literature_documents (
        document_id, schema_version, status, display_name, current_version, current_version_id,
        source_type, permission_scope, created_at, updated_at, disabled_at
      ) VALUES ('document-trigger-missing', '1.0.0', 'ACTIVE', 'trigger.pdf', 1, 'version-trigger-missing', 'OWNER_PROVIDED_LOCAL', 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE', ?, ?, NULL)
    `).run(fixedMigrationTime, fixedMigrationTime)).toThrow();
    database.close();
  });

  it("upgrades v8 Encounter rows to v9 with an explicit seeded source default", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: runtimeMigrations.slice(0, 8),
      clock: () => fixedMigrationTime,
    });
    const oldHistory = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all();
    database.prepare(`
      INSERT INTO encounters (
        id, schema_version, synthetic, case_id, case_version, status,
        demographic_snapshot_json, current_record_revision_id,
        created_at, updated_at, confirmed_at, runtime_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "encounter-v8-seeded",
      "1.0.0",
      1,
      "general-first-001",
      "0.4.1-001",
      "DRAFT",
      '{"displayLabel":"合成患者-01","sex":"NOT_STATED","ageBand":"ADULT"}',
      null,
      fixedMigrationTime,
      fixedMigrationTime,
      null,
      "local-research",
    );

    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect(database.prepare(
      "SELECT source_type, manual_intake_id FROM encounters WHERE id = ?",
    ).get("encounter-v8-seeded")).toEqual({ source_type: "SEEDED_SYNTHETIC", manual_intake_id: null });
    expect(database.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 8 ORDER BY version",
    ).all()).toEqual(oldHistory);
    database.close();
  });

  it("enforces manual intake immutability and source one-to-one binding", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    database.prepare(`
      INSERT INTO manual_synthetic_intakes (
        intake_id, schema_version, creation_request_id, request_fingerprint,
        synthetic, display_label, specialty, visit_type, sex, age,
        visit_date, record_date, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "manual-intake-migrationz001",
      "1.0.0",
      "manual-request-migrationz001",
      "a".repeat(64),
      1,
      "合成手工患者-manual-migrationz001",
      "普通内科",
      "初诊",
      "FEMALE",
      30,
      "2026-08-24",
      "2026-08-24",
      fixedMigrationTime,
    );
    const encounterValues = [
      "encounter-manual-migrationz001", "1.0.0", 1, "manual-synthetic-case-migrationz001",
      "manual-intake-1.0.0", "DRAFT", '{"displayLabel":"合成手工患者-manual-migrationz001","sex":"FEMALE","ageBand":"ADULT"}',
      null, fixedMigrationTime, fixedMigrationTime, null, "local-research", "MANUAL_SYNTHETIC", "manual-intake-migrationz001",
    ] as const;
    database.prepare(`
      INSERT INTO encounters (
        id, schema_version, synthetic, case_id, case_version, status,
        demographic_snapshot_json, current_record_revision_id,
        created_at, updated_at, confirmed_at, runtime_mode, source_type, manual_intake_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...encounterValues);

    expect(database.prepare(
      "SELECT source_type, manual_intake_id FROM encounters WHERE id = ?",
    ).get("encounter-manual-migrationz001")).toEqual({
      source_type: "MANUAL_SYNTHETIC",
      manual_intake_id: "manual-intake-migrationz001",
    });
    expect(() => database.prepare(
      "UPDATE manual_synthetic_intakes SET age = 31 WHERE intake_id = ?",
    ).run("manual-intake-migrationz001")).toThrow();
    expect(() => database.prepare(
      "DELETE FROM manual_synthetic_intakes WHERE intake_id = ?",
    ).run("manual-intake-migrationz001")).toThrow();
    expect(() => database.prepare(`
      INSERT INTO encounters (
        id, schema_version, synthetic, case_id, case_version, status,
        demographic_snapshot_json, current_record_revision_id,
        created_at, updated_at, confirmed_at, runtime_mode, source_type, manual_intake_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "encounter-manual-migrationz002", "1.0.0", 1, "manual-synthetic-case-migrationz002", "manual-intake-1.0.0",
      "DRAFT", '{"displayLabel":"合成手工患者-manual-migrationz002","sex":"FEMALE","ageBand":"ADULT"}',
      null, fixedMigrationTime, fixedMigrationTime, null, "local-research", "MANUAL_SYNTHETIC", "manual-intake-migrationz001",
    )).toThrow();
    expect(() => database.prepare(`
      INSERT INTO encounters (
        id, schema_version, synthetic, case_id, case_version, status,
        demographic_snapshot_json, current_record_revision_id,
        created_at, updated_at, confirmed_at, runtime_mode, source_type, manual_intake_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "encounter-seeded-forged-migrationz001", "1.0.0", 1, "general-first-001", "0.4.1-001",
      "DRAFT", '{"displayLabel":"合成患者-01","sex":"NOT_STATED","ageBand":"ADULT"}',
      null, fixedMigrationTime, fixedMigrationTime, null, "local-research", "SEEDED_SYNTHETIC", "manual-intake-migrationz001",
    )).toThrow();
    database.close();
  });

  it("rejects missing v9 tables, indexes, triggers, wrong constraints, and old checksum drift", () => {
    const missingTable = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    missingTable.exec("DROP TABLE manual_synthetic_intakes");
    expectPersistenceError(
      () => runMigrations(missingTable, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    missingTable.close();

    const missingIndex = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    missingIndex.exec("DROP INDEX ux_manual_synthetic_intakes_creation_request");
    expectPersistenceError(
      () => runMigrations(missingIndex, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    missingIndex.close();

    const missingTrigger = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    missingTrigger.exec("DROP TRIGGER manual_synthetic_intakes_no_update");
    expectPersistenceError(
      () => runMigrations(missingTrigger, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    missingTrigger.close();

    const wrongConstraint = openRuntimeDatabase({
      path: ":memory:",
      migrations: runtimeMigrations.slice(0, 8),
      clock: () => fixedMigrationTime,
    });
    const brokenV9 = {
      ...runtimeMigrations[8],
      sql: runtimeMigrations[8].sql.replace("age BETWEEN 0 AND 150", "age BETWEEN 1 AND 150"),
    } as const;
    expectPersistenceError(
      () => runMigrations(wrongConstraint, [...runtimeMigrations.slice(0, 8), brokenV9], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    expect(getCurrentSchemaVersion(wrongConstraint)).toBe(8);
    wrongConstraint.close();

    const checksumDatabase = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    const driftedV1 = { ...runtimeMigrations[0], sql: `${runtimeMigrations[0].sql}\n` } as const;
    expectPersistenceError(
      () => runMigrations(checksumDatabase, [driftedV1, ...runtimeMigrations.slice(1)], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    checksumDatabase.close();
  });

  it("creates file databases with parent directories and WAL mode", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-runtime-"));
    const databasePath = join(root, "nested", "prototype.db");
    const database = openRuntimeDatabase({ path: databasePath, clock: () => fixedMigrationTime });

    expect(database.location()).toContain("prototype.db");
    expect((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe("wal");

    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent and records an injectable UTC migration timestamp", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);

    const rows = database.prepare("SELECT version, name, applied_at FROM schema_migrations").all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
    expect(rows).toEqual([
      { version: 1, name: "0001_initial_runtime_schema", applied_at: fixedMigrationTime },
      { version: 2, name: "0002_feedback_lifecycle", applied_at: fixedMigrationTime },
      { version: 3, name: "0003_audit_review_queries", applied_at: fixedMigrationTime },
      { version: 4, name: "0004_evaluation_batches", applied_at: fixedMigrationTime },
      { version: 5, name: "0005_dataset_evaluation", applied_at: fixedMigrationTime },
      { version: 6, name: "0006_provider_foundation", applied_at: fixedMigrationTime },
      { version: 7, name: "0007_physician_encounter_workflow", applied_at: fixedMigrationTime },
      { version: 8, name: "0008_pre_sign_review_and_confirmation", applied_at: fixedMigrationTime },
      { version: 9, name: "0009_manual_synthetic_intake", applied_at: fixedMigrationTime },
      { version: 10, name: "0010_literature_import_storage", applied_at: fixedMigrationTime },
      { version: 11, name: "0011_literature_parsing_retrieval", applied_at: fixedMigrationTime },
      { version: 12, name: "0012_model_reference_results", applied_at: fixedMigrationTime },
    ]);
    database.close();
  });

  it("upgrades a real v1 file database to feedback lifecycle v2 without changing the v1 checksum", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-runtime-v1-to-v2-"));
    const databasePath = join(root, "prototype.db");
    const v1Database = openRuntimeDatabase({
      path: databasePath,
      migrations: [runtimeMigrations[0]],
      clock: () => fixedMigrationTime,
    });
    const v1Checksum = (v1Database.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string }).checksum;
    v1Database.close();

    const upgraded = openRuntimeDatabase({ path: databasePath, clock: () => fixedMigrationTime });
    expect(getCurrentSchemaVersion(upgraded)).toBe(12);
    expect((upgraded.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string }).checksum)
      .toBe(v1Checksum);
    expect((upgraded.prepare("PRAGMA table_info(\"feedback_events\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("draft_revision_id");
    expect((upgraded.prepare("PRAGMA index_list(\"audit_events\")").all() as Array<{ name: string }>).map((index) => index.name))
      .toEqual(expect.arrayContaining(["idx_audit_events_type_created", "idx_audit_events_role_created"]));
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects nonempty pre-WP08 feedback data and leaves the database at v1", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0]],
      clock: () => fixedMigrationTime,
    });
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(`
      INSERT INTO feedback_events (
        id, schema_version, generation_run_id, event_type, status, risk_level,
        before_json, after_json, rule_hits_json, decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-feedback-001",
      "1.0.0",
      "untrusted-run",
      "FEEDBACK_CLASSIFIED",
      "CANDIDATE",
      "LOW",
      "{}",
      "{}",
      "[]",
      "{}",
      fixedMigrationTime,
    );

    expectPersistenceError(
      () => runMigrations(database, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    expect(getCurrentSchemaVersion(database)).toBe(1);
    expect((database.prepare("PRAGMA table_info(\"feedback_events\")").all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain("proposal_id");
    database.close();
  });

  it("upgrades a real v2 database to v3, preserves v2 history, and is idempotent", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1]],
      clock: () => fixedMigrationTime,
    });
    const v2Checksum = (database.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get() as { checksum: string }).checksum;

    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);
    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect((database.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>).map((row) => row.version))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect((database.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get() as { checksum: string }).checksum)
      .toBe(v2Checksum);
    database.close();
  });

  it("upgrades v3 through provider foundation with batch and generation-result structures", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2]],
      clock: () => fixedMigrationTime,
    });
    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect((database.prepare("PRAGMA table_info(\"evaluation_batches\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["id", "status", "provider_id", "feedback_rules_version", "configuration_json"]));
    expect((database.prepare("PRAGMA table_info(\"evaluation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["evaluation_batch_id", "pair_key", "profile_id", "profile_version"]));
    expect((database.prepare("PRAGMA table_info(\"evaluation_results\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("generation_run_id");
    expect((database.prepare("PRAGMA table_info(\"generation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("provider_metadata_json");
    expect((database.prepare("PRAGMA table_info(\"evaluation_batches\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("execution_type");
    expect((database.prepare("PRAGMA table_info(\"evaluation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("execution_type");
    expect((database.prepare("PRAGMA index_list(\"evaluation_runs\")").all() as Array<{ name: string; unique: number }>).map((index) => index.name))
      .toEqual(expect.arrayContaining(["idx_evaluation_runs_batch_pair", "ux_evaluation_runs_batch_pair_mode"]));
    expect((database.prepare("PRAGMA index_list(\"evaluation_batches\")").all() as Array<{ name: string }>).map((index) => index.name))
      .toContain("idx_evaluation_batches_execution_type");
    expect((database.prepare("PRAGMA index_list(\"evaluation_runs\")").all() as Array<{ name: string }>).map((index) => index.name))
      .toContain("idx_evaluation_runs_execution_type");
    database.close();
  });

  it("upgrades v4 through provider foundation with dataset feedback result structures", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], runtimeMigrations[3]],
      clock: () => fixedMigrationTime,
    });
    const v4Checksum = (database.prepare("SELECT checksum FROM schema_migrations WHERE version = 4").get() as { checksum: string }).checksum;
    runMigrations(database, runtimeMigrations, () => fixedMigrationTime);

    expect(getCurrentSchemaVersion(database)).toBe(12);
    expect((database.prepare("PRAGMA table_info(\"feedback_evaluation_results\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(["evaluation_batch_id", "fixture_id", "expected_json", "observed_json", "result_status"]));
    expect((database.prepare("PRAGMA index_list(\"feedback_evaluation_results\")").all() as Array<{ name: string }>).map((index) => index.name))
      .toEqual(expect.arrayContaining(["idx_feedback_evaluation_results_batch", "idx_feedback_evaluation_results_status"]));
    expect((database.prepare("SELECT checksum FROM schema_migrations WHERE version = 4").get() as { checksum: string }).checksum)
      .toBe(v4Checksum);
    database.close();
  });

  it("upgrades a real v6 file database to v8 and preserves its history and data", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-sign-review-v6-to-v8-"));
    const databasePath = join(root, "prototype.db");
    const v6Database = openRuntimeDatabase({
      path: databasePath,
      migrations: runtimeMigrations.slice(0, 6),
      clock: () => fixedMigrationTime,
    });
    const v6History = v6Database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    expect(v6History).toEqual(runtimeMigrations.slice(0, 6).map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    })));
    v6Database.prepare(`
      INSERT INTO generation_runs (
        id, schema_version, status, mode, case_id, case_version, dataset_version,
        safety_core_id, safety_core_version, policy_id, policy_version, profile_id,
        profile_version, configuration_key, input_case_snapshot_json,
        effective_config_snapshot_json, output_draft_snapshot_json,
        input_validation_summary_json, output_validation_summary_json, error_type,
        error_message, provider_id, model_id, prompt_version, created_at,
        provider_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "generation-v6-fixture",
      "1.0.0",
      "SUCCEEDED",
      "GENERIC",
      "general-first-001",
      "0.4.1-001",
      "dataset-v6-fixture",
      "safety-core-fixture",
      "1.0.0",
      "policy-fixture",
      "1.0.0",
      null,
      null,
      "fixture-configuration",
      "{}",
      "{}",
      "{}",
      "{}",
      "{}",
      null,
      null,
      "mock",
      "mock-model",
      "prompt-v1",
      fixedMigrationTime,
      '{"provider":"mock"}',
    );
    const v6Data = v6Database.prepare(
      "SELECT id, status, case_id, case_version, provider_metadata_json FROM generation_runs WHERE id = ?",
    ).get("generation-v6-fixture");
    v6Database.close();

    const upgraded = openRuntimeDatabase({ path: databasePath, clock: () => fixedMigrationTime });
    expect(getCurrentSchemaVersion(upgraded)).toBe(12);
    expect((upgraded.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'encounters'",
    ).get())).toEqual({ 1: 1 });
    expect((upgraded.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'encounter_record_revisions'",
    ).get())).toEqual({ 1: 1 });
    expect(upgraded.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 6 ORDER BY version",
    ).all()).toEqual(v6History);
    expect(upgraded.prepare(
      "SELECT id, status, case_id, case_version, provider_metadata_json FROM generation_runs WHERE id = ?",
    ).get("generation-v6-fixture")).toEqual(v6Data);
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("upgrades a real v7 file database to v8 without changing v1-v7 history or Encounter data", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-sign-review-v7-to-v8-"));
    const databasePath = join(root, "prototype.db");
    const v7Database = openRuntimeDatabase({
      path: databasePath,
      migrations: runtimeMigrations.slice(0, 7),
      clock: () => fixedMigrationTime,
    });
    const v7History = v7Database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    expect(v7History).toEqual(runtimeMigrations.slice(0, 7).map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration),
    })));
    v7Database.prepare(`
      INSERT INTO encounters (
        id, schema_version, synthetic, case_id, case_version, status,
        demographic_snapshot_json, current_record_revision_id,
        created_at, updated_at, confirmed_at, runtime_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "encounter-v7-fixture",
      "1.0.0",
      1,
      "general-first-001",
      "0.4.1-001",
      "DRAFT",
      '{"displayLabel":"合成患者-01","sex":"UNKNOWN","ageBand":"ADULT"}',
      null,
      fixedMigrationTime,
      fixedMigrationTime,
      null,
      "local-research",
    );
    const v7Data = v7Database.prepare(
      "SELECT id, status, case_id, case_version, runtime_mode FROM encounters WHERE id = ?",
    ).get("encounter-v7-fixture");
    v7Database.close();

    const upgraded = openRuntimeDatabase({ path: databasePath, clock: () => fixedMigrationTime });
    expect(getCurrentSchemaVersion(upgraded)).toBe(12);
    expect(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pre_sign_reviews'").get())
      .toEqual({ 1: 1 });
    expect(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_item_decisions'").get())
      .toEqual({ 1: 1 });
    expect(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'physician_confirmations'").get())
      .toEqual({ 1: 1 });
    expect((upgraded.prepare("PRAGMA table_info(\"encounters\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("current_record_revision_id");
    expect((upgraded.prepare("PRAGMA table_info(\"encounter_record_revisions\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("record_payload_json");
    expect(upgraded.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version <= 7 ORDER BY version",
    ).all()).toEqual(v7History);
    expect(upgraded.prepare(
      "SELECT id, status, case_id, case_version, runtime_mode FROM encounters WHERE id = ?",
    ).get("encounter-v7-fixture")).toEqual(v7Data);
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rolls back the dataset evaluation migration and history when v5 SQL fails", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], runtimeMigrations[3]],
      clock: () => fixedMigrationTime,
    });
    const brokenMigration = {
      ...runtimeMigrations[4],
      sql: `${runtimeMigrations[4].sql} INSERT INTO table_does_not_exist VALUES ('x');`,
    } as const;

    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], runtimeMigrations[3], brokenMigration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(4);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_evaluation_results'").get()).toBeUndefined();
    database.close();
  });

  it("rolls back the Encounter migration and history when v7 SQL fails", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: runtimeMigrations.slice(0, 6),
      clock: () => fixedMigrationTime,
    });
    const brokenMigration = {
      ...runtimeMigrations[6],
      sql: `${runtimeMigrations[6].sql} INSERT INTO table_does_not_exist VALUES ('x');`,
    } as const;

    expectPersistenceError(
      () => runMigrations(database, [...runtimeMigrations.slice(0, 6), brokenMigration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(6);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'encounters'").get())
      .toBeUndefined();
    expect(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get()).toBeUndefined();
    database.close();
  });

  it("detects v4 index drift and rolls back formal v4 DDL", () => {
    const drifted = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    drifted.exec("DROP INDEX idx_evaluation_runs_profile");
    expectPersistenceError(
      () => runMigrations(drifted, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    drifted.close();

    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2]],
      clock: () => fixedMigrationTime,
    });
    const brokenV4 = {
      ...runtimeMigrations[3],
      sql: `${runtimeMigrations[3].sql} INSERT INTO table_does_not_exist VALUES ('x');`,
    } as const;
    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], brokenV4], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(3);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_batches'").get()).toBeUndefined();
    database.close();
  });

  it("rejects v3 audit index drift and column order drift", () => {
    const missingIndex = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    missingIndex.exec("DROP INDEX idx_audit_events_type_created");
    expectPersistenceError(
      () => runMigrations(missingIndex, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    missingIndex.close();

    const wrongOrder = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    wrongOrder.exec("DROP INDEX idx_audit_events_role_created");
    wrongOrder.exec("CREATE INDEX idx_audit_events_role_created ON audit_events (id, created_at, simulated_role)");
    expectPersistenceError(
      () => runMigrations(wrongOrder, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    wrongOrder.close();
  });

  it("rolls back v3 DDL and history when the query migration fails", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1]],
      clock: () => fixedMigrationTime,
    });
    const failingV3 = {
      version: 3,
      name: "0003_failed_audit_queries",
      sql: "CREATE INDEX idx_audit_events_type_created ON audit_events (event_type, created_at, id); INSERT INTO missing_table VALUES ('x');",
      validateStructure: () => undefined,
    } as const;

    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], runtimeMigrations[1], failingV3], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(2);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_events_type_created'").get())
      .toBeUndefined();
    database.close();
  });

  it("rejects feedback lifecycle schema drift after v2 has been applied", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    database.exec("ALTER TABLE feedback_events DROP COLUMN proposal_id");
    expectPersistenceError(
      () => runMigrations(database, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    database.close();
  });

  it("upgrades the managed runtime to a test v11 and validates the target structure", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });

    runMigrations(database, [...runtimeMigrations, testV11Migration], () => fixedMigrationTime);

    expect(getCurrentSchemaVersion(database)).toBe(13);
    expect((database.prepare("PRAGMA table_info(\"generation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("runtime_marker");
    database.close();
  });

  it("reopens a v10 file database without applying the v1 validator", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-runtime-v10-"));
    const databasePath = join(root, "prototype.db");
    const firstDatabase = openRuntimeDatabase({
      path: databasePath,
      migrations: [...runtimeMigrations, testV11Migration],
      clock: () => fixedMigrationTime,
    });
    firstDatabase.close();

    const reopenedDatabase = openRuntimeDatabase({
      path: databasePath,
      migrations: [...runtimeMigrations, testV11Migration],
      clock: () => fixedMigrationTime,
    });
    expect(getCurrentSchemaVersion(reopenedDatabase)).toBe(13);
    reopenedDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a damaged v11 target structure as migration drift", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    runMigrations(database, [...runtimeMigrations, testV11Migration], () => fixedMigrationTime);
    database.exec("ALTER TABLE generation_runs DROP COLUMN runtime_marker");

    expectPersistenceError(
      () => runMigrations(database, [...runtimeMigrations, testV11Migration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    database.close();
  });

  it("rejects registry version gaps and mismatched name prefixes", () => {
    const versionThree = {
      ...testV11Migration,
      version: 6,
      name: "0006_test_gap",
    } as const;
    const mismatchedName = {
      ...testV11Migration,
      version: 4,
      name: "0004_wrong_prefix",
    } as const;

    const gapDatabase = new DatabaseSync(":memory:");
    expectPersistenceError(
      () => runMigrations(gapDatabase, [runtimeMigrations[0], versionThree], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    gapDatabase.close();

    const nameDatabase = new DatabaseSync(":memory:");
    expectPersistenceError(
      () => runMigrations(nameDatabase, [runtimeMigrations[0], mismatchedName], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    nameDatabase.close();
  });

  it("rolls back a failed v4 migration and its schema history", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2]],
      clock: () => fixedMigrationTime,
    });
    const failingMigration = {
      version: 4,
      name: "0004_failed_upgrade",
      sql: "ALTER TABLE generation_runs ADD COLUMN temporary_marker TEXT; INSERT INTO missing_table VALUES ('x');",
      validateStructure: () => undefined,
    } as const;

    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], failingMigration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(3);
    expect((database.prepare("PRAGMA table_info(\"generation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain("temporary_marker");
    database.close();
  });

  it("rolls back the feedback lifecycle migration when its SQL fails", () => {
    const database = new DatabaseSync(":memory:");
    const failingV2 = {
      version: 2,
      name: "0002_failed_feedback_upgrade",
      sql: "ALTER TABLE generation_runs ADD COLUMN temporary_feedback_marker TEXT; INSERT INTO missing_table VALUES ('x');",
      validateStructure: () => undefined,
    } as const;
    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], failingV2], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(getCurrentSchemaVersion(database)).toBe(1);
    expect((database.prepare("PRAGMA table_info(\"generation_runs\")").all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain("temporary_feedback_marker");
    database.close();
  });

  it("rolls back DDL and migration history when a v4 migration fails", () => {
    const database = openRuntimeDatabase({
      path: ":memory:",
      migrations: [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2]],
      clock: () => fixedMigrationTime,
    });
    const brokenMigration = {
      version: 4,
      name: "0004_broken_test",
      sql: "CREATE TABLE migration_should_rollback (id TEXT); INSERT INTO table_does_not_exist VALUES ('x');",
      validateStructure: () => undefined,
    } as const;

    expectPersistenceError(
      () => runMigrations(database, [runtimeMigrations[0], runtimeMigrations[1], runtimeMigrations[2], brokenMigration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_FAILED,
    );
    expect(database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_should_rollback'",
    ).get()).toBeUndefined();
    expect(getCurrentSchemaVersion(database)).toBe(3);
    database.close();
  });

  it("rejects applied migration name or checksum drift", () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedMigrationTime });
    const driftedMigration = {
      ...runtimeMigrations[0],
      name: "0001_changed_name",
    };

    expectPersistenceError(
      () => runMigrations(database, [driftedMigration], () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    database.close();
  });

  it("rejects an existing business table without managed migration history", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE generation_runs (id TEXT)");

    expectPersistenceError(
      () => runMigrations(database, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    database.close();
  });

  it("rejects an unsafe schema_migrations structure without rewriting it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");

    expectPersistenceError(
      () => runMigrations(database, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    expect((database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["version"]);
    database.close();
  });

  it("rejects business table drift even when migration history claims version one", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE generation_runs (id TEXT PRIMARY KEY);
    `);
    database.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(1, runtimeMigrations[0].name, migrationChecksum(runtimeMigrations[0]), fixedMigrationTime);

    expectPersistenceError(
      () => runMigrations(database, runtimeMigrations, () => fixedMigrationTime),
      persistenceErrorCodes.MIGRATION_DRIFT,
    );
    database.close();
  });
});
