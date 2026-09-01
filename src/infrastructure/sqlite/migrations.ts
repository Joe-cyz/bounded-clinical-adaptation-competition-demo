import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isoUtcTimestampSchema } from "@/domain/runtime-records";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { withTransaction } from "./transaction";

export type RuntimeMigration = {
  version: number;
  name: string;
  sql: string;
  validateStructure: MigrationStructureValidator;
};

export type MigrationStructureValidator = (database: DatabaseSync) => void;

export type MigrationClock = () => string;

const schemaMigrationsTableSql = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

const initialRuntimeSchemaSql = `
  CREATE TABLE generation_runs (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
    mode TEXT NOT NULL CHECK (mode IN ('GENERIC', 'BOUNDED')),
    case_id TEXT NOT NULL,
    case_version TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    safety_core_id TEXT NOT NULL,
    safety_core_version TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    profile_id TEXT,
    profile_version INTEGER,
    configuration_key TEXT NOT NULL,
    input_case_snapshot_json TEXT NOT NULL,
    effective_config_snapshot_json TEXT NOT NULL,
    output_draft_snapshot_json TEXT,
    input_validation_summary_json TEXT NOT NULL,
    output_validation_summary_json TEXT NOT NULL,
    error_type TEXT,
    error_message TEXT,
    provider_id TEXT,
    model_id TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL,
    CHECK (
      (status = 'SUCCEEDED' AND output_draft_snapshot_json IS NOT NULL AND error_type IS NULL AND error_message IS NULL)
      OR
      (status = 'FAILED' AND output_draft_snapshot_json IS NULL AND error_type IS NOT NULL AND error_message IS NOT NULL)
    )
  );

  CREATE TABLE draft_revisions (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    generation_run_id TEXT NOT NULL REFERENCES generation_runs(id),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    diff_summary_json TEXT NOT NULL,
    editor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (generation_run_id, revision_number)
  );

  CREATE TABLE feedback_events (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    generation_run_id TEXT NOT NULL REFERENCES generation_runs(id),
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    rule_hits_json TEXT NOT NULL,
    decision_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE review_decisions (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    feedback_event_id TEXT NOT NULL REFERENCES feedback_events(id),
    actor_id TEXT NOT NULL,
    simulated_role TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE physician_profile_versions (
    profile_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    schema_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'ARCHIVED')),
    synthetic INTEGER NOT NULL CHECK (synthetic = 1),
    preferences_json TEXT NOT NULL,
    previous_version INTEGER,
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, version),
    CHECK (
      (version = 1 AND previous_version IS NULL)
      OR
      (version > 1 AND previous_version IS NOT NULL)
    )
  );

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    simulated_role TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_version TEXT,
    after_version TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE evaluation_runs (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('GENERIC', 'BOUNDED')),
    status TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE evaluation_results (
    id TEXT PRIMARY KEY,
    evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
    schema_version TEXT NOT NULL,
    case_id TEXT NOT NULL,
    case_version TEXT NOT NULL,
    status TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (evaluation_run_id, case_id, case_version)
  );

  CREATE INDEX idx_generation_runs_case_created
    ON generation_runs (case_id, created_at, id);
  CREATE INDEX idx_generation_runs_created
    ON generation_runs (created_at, id);
  CREATE INDEX idx_draft_revisions_generation_run
    ON draft_revisions (generation_run_id, revision_number);
  CREATE INDEX idx_feedback_events_generation_run
    ON feedback_events (generation_run_id, created_at, id);
  CREATE INDEX idx_review_decisions_feedback_event
    ON review_decisions (feedback_event_id, created_at, id);
  CREATE INDEX idx_profile_versions_profile_version
    ON physician_profile_versions (profile_id, version);
  CREATE INDEX idx_profile_versions_created
    ON physician_profile_versions (profile_id, created_at, version);
  CREATE INDEX idx_audit_events_entity_created
    ON audit_events (entity_type, entity_id, created_at, id);
  CREATE INDEX idx_evaluation_results_run
    ON evaluation_results (evaluation_run_id, created_at, id);

  CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit_events are append-only');
    END;

  CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit_events are append-only');
    END;
`;

const feedbackLifecycleMigrationSql = `
  ALTER TABLE feedback_events ADD COLUMN draft_revision_id TEXT REFERENCES draft_revisions(id);
  ALTER TABLE feedback_events ADD COLUMN revision_number INTEGER;
  ALTER TABLE feedback_events ADD COLUMN proposal_id TEXT NOT NULL DEFAULT 'legacy-proposal';
  ALTER TABLE feedback_events ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'legacy-profile';
  ALTER TABLE feedback_events ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE feedback_events ADD COLUMN rules_version TEXT NOT NULL DEFAULT 'feedback-rules-v1';
  ALTER TABLE feedback_events ADD COLUMN change_type TEXT NOT NULL DEFAULT 'REWRITE';
  ALTER TABLE feedback_events ADD COLUMN affected_field TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE feedback_events ADD COLUMN safety_reason TEXT NOT NULL DEFAULT 'Legacy feedback record.';
  ALTER TABLE feedback_events ADD COLUMN next_allowed_actions_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE feedback_events ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE feedback_events ADD COLUMN candidate_patch_json TEXT;
  ALTER TABLE feedback_events ADD COLUMN decision TEXT NOT NULL DEFAULT 'PENDING';
  ALTER TABLE review_decisions ADD COLUMN expected_profile_version INTEGER;

  CREATE INDEX idx_feedback_events_draft_revision
    ON feedback_events (draft_revision_id, created_at, id);
  CREATE INDEX idx_feedback_events_status_risk
    ON feedback_events (status, risk_level, created_at, id);
  CREATE INDEX idx_feedback_events_profile
    ON feedback_events (profile_id, profile_version, created_at, id);
  CREATE UNIQUE INDEX ux_review_decisions_feedback_event
    ON review_decisions (feedback_event_id);
`;

const auditReviewQueriesMigrationSql = `
  CREATE INDEX idx_audit_events_type_created
    ON audit_events (event_type, created_at, id);
  CREATE INDEX idx_audit_events_role_created
    ON audit_events (simulated_role, created_at, id);
`;

const evaluationExportMigrationSql = `
  CREATE TABLE evaluation_batches (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL_FAILURE', 'FAILED')),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    safety_core_id TEXT NOT NULL,
    safety_core_version TEXT NOT NULL,
    feedback_rules_version TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );

  ALTER TABLE evaluation_runs ADD COLUMN evaluation_batch_id TEXT REFERENCES evaluation_batches(id);
  ALTER TABLE evaluation_runs ADD COLUMN pair_key TEXT;
  ALTER TABLE evaluation_runs ADD COLUMN profile_id TEXT;
  ALTER TABLE evaluation_runs ADD COLUMN profile_version INTEGER;
  ALTER TABLE evaluation_results ADD COLUMN generation_run_id TEXT REFERENCES generation_runs(id);

  CREATE INDEX idx_evaluation_batches_started
    ON evaluation_batches (started_at, id);
  CREATE INDEX idx_evaluation_runs_batch_pair
    ON evaluation_runs (evaluation_batch_id, pair_key, mode, id);
  CREATE UNIQUE INDEX ux_evaluation_runs_batch_pair_mode
    ON evaluation_runs (evaluation_batch_id, pair_key, mode)
    WHERE evaluation_batch_id IS NOT NULL;
  CREATE INDEX idx_evaluation_runs_profile
    ON evaluation_runs (profile_id, profile_version, started_at, id);
  CREATE INDEX idx_evaluation_results_generation_run
    ON evaluation_results (generation_run_id, created_at, id);
`;

const datasetEvaluationMigrationSql = `
  CREATE TABLE feedback_evaluation_results (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    evaluation_batch_id TEXT NOT NULL REFERENCES evaluation_batches(id),
    generation_run_id TEXT REFERENCES generation_runs(id),
    dataset_version TEXT NOT NULL,
    fixture_id TEXT NOT NULL,
    fixture_version TEXT NOT NULL,
    case_id TEXT NOT NULL,
    case_version TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_version INTEGER NOT NULL,
    mutation_type TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    observed_json TEXT NOT NULL,
    result_status TEXT NOT NULL CHECK (result_status IN ('PASS', 'FAIL')),
    rules_version TEXT NOT NULL,
    revision_saved INTEGER NOT NULL CHECK (revision_saved IN (0, 1)),
    profile_updated INTEGER NOT NULL CHECK (profile_updated IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE (evaluation_batch_id, fixture_id, fixture_version)
  );

  CREATE INDEX idx_feedback_evaluation_results_batch
    ON feedback_evaluation_results (evaluation_batch_id, created_at, id);
  CREATE INDEX idx_feedback_evaluation_results_status
    ON feedback_evaluation_results (result_status, created_at, id);
  CREATE INDEX idx_feedback_evaluation_results_fixture
    ON feedback_evaluation_results (fixture_id, fixture_version, created_at, id);
`;

const providerFoundationMigrationSql = `
  ALTER TABLE generation_runs ADD COLUMN provider_metadata_json TEXT;
  ALTER TABLE evaluation_batches ADD COLUMN execution_type TEXT NOT NULL DEFAULT 'MOCK';
  ALTER TABLE evaluation_runs ADD COLUMN execution_type TEXT NOT NULL DEFAULT 'MOCK';

  CREATE INDEX idx_evaluation_batches_execution_type
    ON evaluation_batches (execution_type, started_at, id);
  CREATE INDEX idx_evaluation_runs_execution_type
    ON evaluation_runs (execution_type, started_at, id);
`;

const encounterWorkflowMigrationSql = `
  CREATE TABLE encounters (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK (synthetic = 1),
    case_id TEXT NOT NULL,
    case_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'RECORD_SAVED', 'REFERENCE_VIEWED', 'REVIEW_PENDING', 'CONFIRMED')),
    demographic_snapshot_json TEXT NOT NULL,
    current_record_revision_id TEXT REFERENCES encounter_record_revisions(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmed_at TEXT,
    runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('public-demo', 'local-research')),
    CHECK (status = 'DRAFT' OR current_record_revision_id IS NOT NULL),
    CHECK (
      (status = 'CONFIRMED' AND confirmed_at IS NOT NULL)
      OR
      (status <> 'CONFIRMED' AND confirmed_at IS NULL)
    ),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (confirmed_at IS NULL OR julianday(confirmed_at) >= julianday(updated_at))
  );

  CREATE TABLE encounter_record_revisions (
    id TEXT PRIMARY KEY,
    encounter_id TEXT NOT NULL REFERENCES encounters(id),
    schema_version TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    record_payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (encounter_id, revision_number)
  );

  CREATE INDEX idx_encounters_status_updated
    ON encounters (status, updated_at, id);
  CREATE INDEX idx_encounters_case_created
    ON encounters (case_id, case_version, created_at, id);
  CREATE INDEX idx_encounters_runtime_status
    ON encounters (runtime_mode, status, updated_at, id);
  CREATE INDEX idx_encounter_record_revisions_encounter
    ON encounter_record_revisions (encounter_id, revision_number, created_at, id);

  CREATE TRIGGER encounter_record_revisions_no_update
    BEFORE UPDATE ON encounter_record_revisions
    BEGIN
      SELECT RAISE(ABORT, 'encounter_record_revisions are immutable');
    END;

  CREATE TRIGGER encounter_record_revisions_no_delete
    BEFORE DELETE ON encounter_record_revisions
    BEGIN
      SELECT RAISE(ABORT, 'encounter_record_revisions are immutable');
    END;

  CREATE TRIGGER encounters_current_revision_matches_insert
    AFTER INSERT ON encounters
    WHEN NEW.current_record_revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM encounter_record_revisions
        WHERE id = NEW.current_record_revision_id AND encounter_id = NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'current record revision does not belong to encounter');
    END;

  CREATE TRIGGER encounters_current_revision_matches_update
    AFTER UPDATE OF current_record_revision_id ON encounters
    WHEN NEW.current_record_revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM encounter_record_revisions
        WHERE id = NEW.current_record_revision_id AND encounter_id = NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'current record revision does not belong to encounter');
    END;
`;

const preSignReviewMigrationSql = `
  CREATE TABLE pre_sign_reviews (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    encounter_id TEXT NOT NULL REFERENCES encounters(id),
    record_revision_id TEXT NOT NULL REFERENCES encounter_record_revisions(id),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    ruleset_version TEXT NOT NULL,
    items_json TEXT NOT NULL,
    blocking_count INTEGER NOT NULL CHECK (blocking_count >= 0),
    pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (encounter_id, record_revision_id)
  );

  CREATE TABLE review_item_decisions (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    review_id TEXT NOT NULL REFERENCES pre_sign_reviews(id),
    item_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('CHECKED', 'NOT_APPLICABLE')),
    reason TEXT,
    actor_id TEXT NOT NULL,
    simulated_role TEXT NOT NULL CHECK (simulated_role = 'PHYSICIAN'),
    created_at TEXT NOT NULL,
    UNIQUE (review_id, item_id),
    CHECK (
      (decision = 'CHECKED' AND reason IS NULL)
      OR
      (decision = 'NOT_APPLICABLE' AND reason IS NOT NULL)
    )
  );

  CREATE TABLE physician_confirmations (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    encounter_id TEXT NOT NULL REFERENCES encounters(id),
    review_id TEXT NOT NULL REFERENCES pre_sign_reviews(id),
    record_revision_id TEXT NOT NULL REFERENCES encounter_record_revisions(id),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    decision_summary_json TEXT NOT NULL,
    disclaimer_version TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    simulated_role TEXT NOT NULL CHECK (simulated_role = 'PHYSICIAN'),
    confirmed_at TEXT NOT NULL,
    UNIQUE (encounter_id)
  );

  CREATE INDEX idx_pre_sign_reviews_encounter_created
    ON pre_sign_reviews (encounter_id, created_at, id);
  CREATE INDEX idx_pre_sign_reviews_revision
    ON pre_sign_reviews (record_revision_id, created_at, id);
  CREATE INDEX idx_review_item_decisions_review_created
    ON review_item_decisions (review_id, created_at, id);
  CREATE INDEX idx_physician_confirmations_encounter
    ON physician_confirmations (encounter_id, confirmed_at, id);

  CREATE TRIGGER pre_sign_reviews_revision_matches_encounter
    AFTER INSERT ON pre_sign_reviews
    WHEN NOT EXISTS (
      SELECT 1 FROM encounter_record_revisions
      WHERE id = NEW.record_revision_id AND encounter_id = NEW.encounter_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'review record revision does not belong to encounter');
    END;

  CREATE TRIGGER physician_confirmations_binding_matches_encounter
    AFTER INSERT ON physician_confirmations
    WHEN NOT EXISTS (
      SELECT 1 FROM pre_sign_reviews
      WHERE id = NEW.review_id
        AND encounter_id = NEW.encounter_id
        AND record_revision_id = NEW.record_revision_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'physician confirmation binding does not match encounter');
    END;

  CREATE TRIGGER pre_sign_reviews_no_update
    BEFORE UPDATE ON pre_sign_reviews
    BEGIN
      SELECT RAISE(ABORT, 'pre_sign_reviews are immutable');
    END;

  CREATE TRIGGER pre_sign_reviews_no_delete
    BEFORE DELETE ON pre_sign_reviews
    BEGIN
      SELECT RAISE(ABORT, 'pre_sign_reviews are immutable');
    END;

  CREATE TRIGGER review_item_decisions_no_update
    BEFORE UPDATE ON review_item_decisions
    BEGIN
      SELECT RAISE(ABORT, 'review_item_decisions are append-only');
    END;

  CREATE TRIGGER review_item_decisions_no_delete
    BEFORE DELETE ON review_item_decisions
    BEGIN
      SELECT RAISE(ABORT, 'review_item_decisions are append-only');
    END;

  CREATE TRIGGER physician_confirmations_no_update
    BEFORE UPDATE ON physician_confirmations
    BEGIN
      SELECT RAISE(ABORT, 'physician_confirmations are immutable');
    END;

  CREATE TRIGGER physician_confirmations_no_delete
    BEFORE DELETE ON physician_confirmations
    BEGIN
      SELECT RAISE(ABORT, 'physician_confirmations are immutable');
    END;
`;

const manualSyntheticIntakeMigrationSql = `
  CREATE TABLE manual_synthetic_intakes (
    intake_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    creation_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    synthetic INTEGER NOT NULL CHECK (synthetic = 1),
    display_label TEXT NOT NULL,
    specialty TEXT NOT NULL CHECK (specialty IN ('普通内科', '内分泌科')),
    visit_type TEXT NOT NULL CHECK (visit_type IN ('初诊', '慢病复诊')),
    sex TEXT NOT NULL CHECK (sex IN ('FEMALE', 'MALE', 'INTERSEX')),
    age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 150),
    visit_date TEXT NOT NULL,
    record_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (record_date >= visit_date)
  );

  CREATE UNIQUE INDEX ux_manual_synthetic_intakes_creation_request
    ON manual_synthetic_intakes (creation_request_id);
  CREATE INDEX idx_manual_synthetic_intakes_created
    ON manual_synthetic_intakes (created_at, intake_id);

  ALTER TABLE encounters
    ADD COLUMN source_type TEXT NOT NULL DEFAULT 'SEEDED_SYNTHETIC'
      CHECK (source_type IN ('SEEDED_SYNTHETIC', 'MANUAL_SYNTHETIC'));
  ALTER TABLE encounters
    ADD COLUMN manual_intake_id TEXT REFERENCES manual_synthetic_intakes(intake_id);

  CREATE UNIQUE INDEX ux_encounters_manual_intake
    ON encounters (manual_intake_id)
    WHERE manual_intake_id IS NOT NULL;
  CREATE INDEX idx_encounters_source_created
    ON encounters (source_type, created_at, id);

  CREATE TRIGGER manual_synthetic_intakes_no_update
    BEFORE UPDATE ON manual_synthetic_intakes
    BEGIN
      SELECT RAISE(ABORT, 'manual_synthetic_intakes are immutable');
    END;

  CREATE TRIGGER manual_synthetic_intakes_no_delete
    BEFORE DELETE ON manual_synthetic_intakes
    BEGIN
      SELECT RAISE(ABORT, 'manual_synthetic_intakes are immutable');
    END;

  CREATE TRIGGER encounters_source_binding_insert
    BEFORE INSERT ON encounters
    WHEN (NEW.source_type = 'SEEDED_SYNTHETIC' AND NEW.manual_intake_id IS NOT NULL)
      OR (NEW.source_type = 'MANUAL_SYNTHETIC' AND NEW.manual_intake_id IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'encounter source binding is invalid');
    END;

  CREATE TRIGGER encounters_source_binding_update
    BEFORE UPDATE OF source_type, manual_intake_id ON encounters
    WHEN OLD.source_type IS NOT NEW.source_type
      OR OLD.manual_intake_id IS NOT NEW.manual_intake_id
      OR (NEW.source_type = 'SEEDED_SYNTHETIC' AND NEW.manual_intake_id IS NOT NULL)
      OR (NEW.source_type = 'MANUAL_SYNTHETIC' AND NEW.manual_intake_id IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'encounter source binding is immutable');
    END;
`;

const literatureImportStorageMigrationSql = `
  CREATE TABLE literature_import_batches (
    batch_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    status TEXT NOT NULL CHECK (status IN ('RESERVED', 'UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    expected_file_count INTEGER NOT NULL CHECK (expected_file_count BETWEEN 1 AND 3),
    expected_total_bytes INTEGER NOT NULL CHECK (expected_total_bytes BETWEEN 1 AND 209715200),
    received_file_count INTEGER NOT NULL DEFAULT 0 CHECK (received_file_count BETWEEN 0 AND expected_file_count),
    received_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_total_bytes BETWEEN 0 AND expected_total_bytes),
    source_type TEXT NOT NULL CHECK (source_type = 'OWNER_PROVIDED_LOCAL'),
    permission_scope TEXT NOT NULL CHECK (permission_scope = 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    failure_code TEXT,
    UNIQUE (request_id),
    CHECK ((status = 'COMPLETED' AND completed_at IS NOT NULL) OR (status <> 'COMPLETED' AND completed_at IS NULL))
  );

  CREATE TABLE literature_import_items (
    item_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES literature_import_batches(batch_id),
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    client_file_id TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('CREATE_DOCUMENT', 'ADD_VERSION')),
    document_id TEXT REFERENCES literature_documents(document_id),
    expected_current_version INTEGER,
    original_filename TEXT NOT NULL,
    declared_extension TEXT NOT NULL CHECK (declared_extension IN ('.pdf', '.txt')),
    declared_mime TEXT NOT NULL,
    expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 104857600),
    status TEXT NOT NULL CHECK (status IN ('RESERVED', 'UPLOADING', 'VALIDATED', 'AVAILABLE', 'FAILED', 'CANCELLED')),
    actual_size_bytes INTEGER CHECK (actual_size_bytes IS NULL OR actual_size_bytes BETWEEN 1 AND 104857600),
    actual_sha256 TEXT CHECK (actual_sha256 IS NULL OR length(actual_sha256) = 64),
    storage_key TEXT,
    detected_format TEXT CHECK (detected_format IS NULL OR detected_format IN ('PDF', 'UTF8_TEXT')),
    detected_mime TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (batch_id, client_file_id),
    CHECK ((intent = 'CREATE_DOCUMENT' AND document_id IS NULL AND expected_current_version IS NULL)
      OR (intent = 'ADD_VERSION' AND document_id IS NOT NULL AND expected_current_version IS NOT NULL AND expected_current_version > 0)),
    CHECK (
      (status IN ('RESERVED', 'UPLOADING')
        AND actual_size_bytes IS NULL AND actual_sha256 IS NULL AND storage_key IS NULL
        AND detected_format IS NULL AND detected_mime IS NULL AND completed_at IS NULL)
      OR (status = 'VALIDATED'
        AND actual_size_bytes IS NOT NULL AND actual_sha256 IS NOT NULL AND storage_key IS NOT NULL
        AND detected_format IS NOT NULL AND detected_mime IS NOT NULL AND completed_at IS NULL)
      OR (status = 'AVAILABLE'
        AND actual_size_bytes IS NOT NULL AND actual_sha256 IS NOT NULL AND storage_key IS NOT NULL
        AND detected_format IS NOT NULL AND detected_mime IS NOT NULL AND completed_at IS NOT NULL)
      OR (status IN ('FAILED', 'CANCELLED') AND completed_at IS NULL)
    )
  );

  CREATE TABLE literature_documents (
    document_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
    display_name TEXT NOT NULL,
    current_version INTEGER NOT NULL CHECK (current_version >= 1),
    current_version_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type = 'OWNER_PROVIDED_LOCAL'),
    permission_scope TEXT NOT NULL CHECK (permission_scope = 'OWNER_AUTHORIZED_LOCAL_PROTOTYPE'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT,
    CHECK ((status = 'DISABLED' AND disabled_at IS NOT NULL) OR (status = 'ACTIVE' AND disabled_at IS NULL)),
    FOREIGN KEY (current_version_id) REFERENCES literature_document_versions(version_id) DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE literature_document_versions (
    version_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES literature_documents(document_id) DEFERRABLE INITIALLY DEFERRED,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    format TEXT NOT NULL CHECK (format IN ('PDF', 'UTF8_TEXT')),
    original_filename TEXT NOT NULL,
    declared_mime TEXT NOT NULL,
    detected_mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    storage_key TEXT NOT NULL,
    import_batch_id TEXT NOT NULL REFERENCES literature_import_batches(batch_id),
    import_item_id TEXT NOT NULL REFERENCES literature_import_items(item_id),
    created_at TEXT NOT NULL,
    UNIQUE (document_id, version_number),
    UNIQUE (sha256),
    UNIQUE (storage_key),
    UNIQUE (import_item_id),
    CHECK (storage_key LIKE 'objects/%' AND storage_key NOT LIKE '%..%' AND storage_key NOT LIKE '%\\%' ESCAPE '\\' AND storage_key NOT LIKE '%:%')
  );

  CREATE INDEX idx_literature_import_batches_status_updated
    ON literature_import_batches (status, updated_at, batch_id);
  CREATE INDEX idx_literature_import_items_batch_status
    ON literature_import_items (batch_id, status, created_at, item_id);
  CREATE INDEX idx_literature_import_items_sha256
    ON literature_import_items (actual_sha256, status);
  CREATE UNIQUE INDEX ux_literature_import_items_active_sha256
    ON literature_import_items (actual_sha256)
    WHERE actual_sha256 IS NOT NULL AND status IN ('VALIDATED', 'AVAILABLE');
  CREATE INDEX idx_literature_documents_status_updated
    ON literature_documents (status, updated_at, document_id);
  CREATE INDEX idx_literature_versions_document_version
    ON literature_document_versions (document_id, version_number, created_at, version_id);
  CREATE UNIQUE INDEX ux_literature_versions_sha256
    ON literature_document_versions (sha256);
  CREATE UNIQUE INDEX ux_literature_versions_storage_key
    ON literature_document_versions (storage_key);

  CREATE TRIGGER literature_document_versions_no_update
    BEFORE UPDATE ON literature_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'literature_document_versions are immutable');
    END;

  CREATE TRIGGER literature_document_versions_no_delete
    BEFORE DELETE ON literature_document_versions
    BEGIN
      SELECT RAISE(ABORT, 'literature_document_versions are immutable');
    END;

  CREATE TRIGGER literature_documents_current_version_matches_insert
    AFTER INSERT ON literature_documents
    WHEN NOT EXISTS (
      SELECT 1 FROM literature_document_versions
      WHERE version_id = NEW.current_version_id AND document_id = NEW.document_id
        AND version_number = NEW.current_version
    )
    BEGIN
      SELECT RAISE(ABORT, 'literature current version does not belong to document');
    END;

  CREATE TRIGGER literature_documents_current_version_matches_update
    AFTER UPDATE OF current_version, current_version_id ON literature_documents
    WHEN NOT EXISTS (
      SELECT 1 FROM literature_document_versions
      WHERE version_id = NEW.current_version_id
        AND document_id = NEW.document_id
        AND version_number = NEW.current_version
    )
    BEGIN
      SELECT RAISE(ABORT, 'literature current version does not belong to document');
    END;
`;

const literatureParsingMigrationSql = `
  CREATE TABLE literature_parse_runs (
    parse_run_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    parse_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    document_id TEXT NOT NULL REFERENCES literature_documents(document_id),
    version_id TEXT NOT NULL REFERENCES literature_document_versions(version_id),
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'PARSING', 'READY', 'FAILED')),
    page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count BETWEEN 0 AND 2500),
    code_point_count INTEGER NOT NULL DEFAULT 0 CHECK (code_point_count BETWEEN 0 AND 20000000),
    fragment_count INTEGER NOT NULL DEFAULT 0 CHECK (fragment_count BETWEEN 0 AND 25000),
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    failure_code TEXT,
    UNIQUE (parse_request_id),
    CHECK ((status = 'READY' AND completed_at IS NOT NULL AND failure_code IS NULL)
      OR (status <> 'READY' AND completed_at IS NULL)),
    CHECK ((status = 'FAILED' AND failure_code IS NOT NULL) OR (status <> 'FAILED' AND failure_code IS NULL))
  );

  CREATE TABLE literature_pages (
    page_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    parse_run_id TEXT NOT NULL REFERENCES literature_parse_runs(parse_run_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES literature_documents(document_id),
    version_id TEXT NOT NULL REFERENCES literature_document_versions(version_id),
    page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 2500),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('PDF_PAGE', 'TXT_LINES')),
    text TEXT NOT NULL,
    code_point_count INTEGER NOT NULL CHECK (code_point_count BETWEEN 0 AND 250000),
    text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
    UNIQUE (parse_run_id, page_number)
  );

  CREATE TABLE literature_fragments (
    fragment_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    parse_run_id TEXT NOT NULL REFERENCES literature_parse_runs(parse_run_id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES literature_pages(page_id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES literature_documents(document_id),
    version_id TEXT NOT NULL REFERENCES literature_document_versions(version_id),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 25000),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('PDF_PAGE', 'TXT_LINES')),
    page_number INTEGER,
    start_code_point INTEGER,
    end_code_point INTEGER,
    start_line INTEGER,
    end_line INTEGER,
    title TEXT,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1200),
    normalized_text TEXT NOT NULL CHECK (length(normalized_text) BETWEEN 1 AND 1200),
    text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
    UNIQUE (parse_run_id, ordinal),
    CHECK ((source_kind = 'PDF_PAGE'
      AND page_number IS NOT NULL AND start_code_point IS NOT NULL AND end_code_point IS NOT NULL
      AND start_line IS NULL AND end_line IS NULL)
      OR (source_kind = 'TXT_LINES'
      AND page_number IS NULL AND start_code_point IS NULL AND end_code_point IS NULL
      AND start_line IS NOT NULL AND end_line IS NOT NULL)),
    CHECK (source_kind <> 'PDF_PAGE' OR end_code_point > start_code_point),
    CHECK (source_kind <> 'TXT_LINES' OR end_line >= start_line)
  );

  CREATE UNIQUE INDEX ux_literature_parse_request
    ON literature_parse_runs (parse_request_id);
  CREATE UNIQUE INDEX ux_literature_parse_active_version
    ON literature_parse_runs (version_id)
    WHERE status = 'PARSING';
  CREATE UNIQUE INDEX ux_literature_parse_ready_version
    ON literature_parse_runs (version_id)
    WHERE status = 'READY';
  CREATE INDEX idx_literature_parse_version_status
    ON literature_parse_runs (version_id, status, updated_at, parse_run_id);
  CREATE INDEX idx_literature_pages_run
    ON literature_pages (parse_run_id, page_number, page_id);
  CREATE INDEX idx_literature_fragments_run
    ON literature_fragments (parse_run_id, ordinal, fragment_id);
  CREATE INDEX idx_literature_fragments_version
    ON literature_fragments (version_id, document_id, ordinal, fragment_id);

  CREATE TRIGGER literature_pages_binding_insert
    BEFORE INSERT ON literature_pages
    WHEN NOT EXISTS (
      SELECT 1 FROM literature_parse_runs
      WHERE parse_run_id = NEW.parse_run_id
        AND document_id = NEW.document_id
        AND version_id = NEW.version_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'literature page binding is invalid');
    END;

  CREATE TRIGGER literature_fragments_binding_insert
    BEFORE INSERT ON literature_fragments
    WHEN NOT EXISTS (
      SELECT 1 FROM literature_pages
      WHERE page_id = NEW.page_id
        AND parse_run_id = NEW.parse_run_id
        AND document_id = NEW.document_id
        AND version_id = NEW.version_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'literature fragment binding is invalid');
    END;

  CREATE VIRTUAL TABLE literature_fragments_fts USING fts5(
    fragment_id UNINDEXED,
    document_id UNINDEXED,
    version_id UNINDEXED,
    text,
    normalized_text,
    tokenize = 'trigram'
  );

  CREATE TRIGGER literature_fragments_fts_insert
    AFTER INSERT ON literature_fragments
    BEGIN
      INSERT INTO literature_fragments_fts (fragment_id, document_id, version_id, text, normalized_text)
      VALUES (NEW.fragment_id, NEW.document_id, NEW.version_id, NEW.text, NEW.normalized_text);
    END;

  CREATE TRIGGER literature_fragments_fts_delete
    AFTER DELETE ON literature_fragments
    BEGIN
      DELETE FROM literature_fragments_fts WHERE fragment_id = OLD.fragment_id;
    END;
`;

// 0012 is append-only. Model-reference prompts, provider raw responses and
// literature正文 are deliberately not persisted; only validated, bounded
// projections and stable identifiers are retained.
const modelReferenceContractsMigrationSql = `
  CREATE TABLE model_reference_runs (
    reference_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    reference_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    encounter_id TEXT NOT NULL REFERENCES encounters(id),
    record_revision_id TEXT NOT NULL REFERENCES encounter_record_revisions(id),
    revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 100000),
    kind TEXT NOT NULL CHECK (kind IN ('GENERAL', 'LITERATURE_GROUNDED')),
    evidence_level TEXT NOT NULL CHECK (evidence_level IN ('GENERAL_MODEL_NO_LOCAL_EVIDENCE', 'SELECTED_LOCAL_LITERATURE')),
    question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 800),
    documents_fingerprint TEXT NOT NULL CHECK (length(documents_fingerprint) = 64),
    prompt_version TEXT NOT NULL,
    prompt_digest TEXT CHECK (prompt_digest IS NULL OR length(prompt_digest) = 64),
    provider_id TEXT,
    model_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'STALE')),
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (reference_request_id),
    CHECK ((kind = 'GENERAL' AND evidence_level = 'GENERAL_MODEL_NO_LOCAL_EVIDENCE')
      OR (kind = 'LITERATURE_GROUNDED' AND evidence_level = 'SELECTED_LOCAL_LITERATURE')),
    CHECK ((status = 'COMPLETED' AND completed_at IS NOT NULL AND failure_code IS NULL)
      OR (status <> 'COMPLETED' AND completed_at IS NULL)),
    CHECK ((status = 'FAILED' AND failure_code IS NOT NULL) OR (status <> 'FAILED' AND failure_code IS NULL))
  );

  CREATE TABLE model_reference_items (
    item_id TEXT PRIMARY KEY,
    reference_id TEXT NOT NULL REFERENCES model_reference_runs(reference_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
    kind TEXT NOT NULL CHECK (kind IN ('NEEDS_VERIFICATION', 'CONSIDERATION_DIRECTION', 'ADDITIONAL_CHECK_OR_SOURCE')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 960),
    fact_ids_json TEXT NOT NULL,
    UNIQUE (reference_id, ordinal)
  );

  CREATE TABLE model_reference_supports (
    support_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES model_reference_items(item_id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL CHECK (evidence_id IN ('E1', 'E2', 'E3', 'E4', 'E5')),
    document_id TEXT NOT NULL REFERENCES literature_documents(document_id),
    version_id TEXT NOT NULL REFERENCES literature_document_versions(version_id),
    fragment_id TEXT NOT NULL REFERENCES literature_fragments(fragment_id),
    quote TEXT NOT NULL CHECK (length(quote) BETWEEN 12 AND 640),
    UNIQUE (item_id, evidence_id)
  );

  CREATE TABLE model_reference_followups (
    follow_up_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    follow_up_request_id TEXT NOT NULL,
    reference_id TEXT NOT NULL REFERENCES model_reference_runs(reference_id),
    item_id TEXT NOT NULL REFERENCES model_reference_items(item_id),
    encounter_id TEXT NOT NULL REFERENCES encounters(id),
    record_revision_id TEXT NOT NULL REFERENCES encounter_record_revisions(id),
    item_kind TEXT NOT NULL CHECK (item_kind = 'NEEDS_VERIFICATION'),
    status TEXT NOT NULL CHECK (status IN ('SELECTED', 'CONSUMED', 'STALE')),
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE (follow_up_request_id),
    UNIQUE (reference_id, item_id),
    CHECK ((status = 'CONSUMED' AND consumed_at IS NOT NULL) OR (status <> 'CONSUMED' AND consumed_at IS NULL))
  );

  CREATE INDEX idx_model_reference_runs_encounter_created
    ON model_reference_runs (encounter_id, created_at, reference_id);
  CREATE INDEX idx_model_reference_runs_revision
    ON model_reference_runs (record_revision_id, created_at, reference_id);
  CREATE INDEX idx_model_reference_items_reference
    ON model_reference_items (reference_id, ordinal, item_id);
  CREATE INDEX idx_model_reference_supports_item
    ON model_reference_supports (item_id, support_id);
  CREATE INDEX idx_model_reference_followups_encounter_status
    ON model_reference_followups (encounter_id, status, created_at, follow_up_id);

  CREATE TRIGGER model_reference_items_no_update
    BEFORE UPDATE ON model_reference_items
    BEGIN SELECT RAISE(ABORT, 'model reference items are immutable'); END;
  CREATE TRIGGER model_reference_items_no_delete
    BEFORE DELETE ON model_reference_items
    BEGIN SELECT RAISE(ABORT, 'model reference items are immutable'); END;
  CREATE TRIGGER model_reference_supports_no_update
    BEFORE UPDATE ON model_reference_supports
    BEGIN SELECT RAISE(ABORT, 'model reference supports are immutable'); END;
  CREATE TRIGGER model_reference_supports_no_delete
    BEFORE DELETE ON model_reference_supports
    BEGIN SELECT RAISE(ABORT, 'model reference supports are immutable'); END;
  CREATE TRIGGER model_reference_followups_no_update
    BEFORE UPDATE ON model_reference_followups
    BEGIN SELECT RAISE(ABORT, 'model reference followups are immutable'); END;
  CREATE TRIGGER model_reference_followups_no_delete
    BEFORE DELETE ON model_reference_followups
    BEGIN SELECT RAISE(ABORT, 'model reference followups are immutable'); END;
`;

type ExpectedTableColumn = { name: string; type: string; primaryKeyPosition: number };
type ExpectedIndex = { name: string; table: string; columns: readonly string[] };

function expectedColumns(
  columns: readonly [string, string, number][],
): ExpectedTableColumn[] {
  return columns.map(([name, type, primaryKeyPosition]) => ({ name, type, primaryKeyPosition }));
}

const expectedInitialTableColumns: Record<string, readonly ExpectedTableColumn[]> = {
  generation_runs: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["status", "TEXT", 0], ["mode", "TEXT", 0],
    ["case_id", "TEXT", 0], ["case_version", "TEXT", 0], ["dataset_version", "TEXT", 0],
    ["safety_core_id", "TEXT", 0], ["safety_core_version", "TEXT", 0], ["policy_id", "TEXT", 0],
    ["policy_version", "TEXT", 0], ["profile_id", "TEXT", 0], ["profile_version", "INTEGER", 0],
    ["configuration_key", "TEXT", 0], ["input_case_snapshot_json", "TEXT", 0],
    ["effective_config_snapshot_json", "TEXT", 0], ["output_draft_snapshot_json", "TEXT", 0],
    ["input_validation_summary_json", "TEXT", 0], ["output_validation_summary_json", "TEXT", 0],
    ["error_type", "TEXT", 0], ["error_message", "TEXT", 0], ["provider_id", "TEXT", 0],
    ["model_id", "TEXT", 0], ["prompt_version", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  draft_revisions: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["generation_run_id", "TEXT", 0],
    ["revision_number", "INTEGER", 0], ["before_json", "TEXT", 0], ["after_json", "TEXT", 0],
    ["diff_summary_json", "TEXT", 0], ["editor_id", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  feedback_events: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["generation_run_id", "TEXT", 0],
    ["event_type", "TEXT", 0], ["status", "TEXT", 0], ["risk_level", "TEXT", 0],
    ["before_json", "TEXT", 0], ["after_json", "TEXT", 0], ["rule_hits_json", "TEXT", 0],
    ["decision_json", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  review_decisions: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["feedback_event_id", "TEXT", 0],
    ["actor_id", "TEXT", 0], ["simulated_role", "TEXT", 0], ["decision", "TEXT", 0],
    ["rationale", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  physician_profile_versions: expectedColumns([
    ["profile_id", "TEXT", 1], ["version", "INTEGER", 2], ["schema_version", "TEXT", 0],
    ["status", "TEXT", 0], ["synthetic", "INTEGER", 0], ["preferences_json", "TEXT", 0],
    ["previous_version", "INTEGER", 0], ["source_type", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  audit_events: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["event_type", "TEXT", 0],
    ["actor_id", "TEXT", 0], ["simulated_role", "TEXT", 0], ["entity_type", "TEXT", 0],
    ["entity_id", "TEXT", 0], ["before_version", "TEXT", 0], ["after_version", "TEXT", 0],
    ["metadata_json", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  evaluation_runs: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["dataset_version", "TEXT", 0],
    ["mode", "TEXT", 0], ["status", "TEXT", 0], ["configuration_json", "TEXT", 0],
    ["started_at", "TEXT", 0], ["completed_at", "TEXT", 0],
  ]),
  evaluation_results: expectedColumns([
    ["id", "TEXT", 1], ["evaluation_run_id", "TEXT", 0], ["schema_version", "TEXT", 0],
    ["case_id", "TEXT", 0], ["case_version", "TEXT", 0], ["status", "TEXT", 0],
    ["metrics_json", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
};

const expectedEvaluationBatchColumns: Record<string, readonly ExpectedTableColumn[]> = {
  evaluation_batches: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["dataset_version", "TEXT", 0],
    ["status", "TEXT", 0], ["provider_id", "TEXT", 0], ["model_id", "TEXT", 0],
    ["prompt_version", "TEXT", 0], ["safety_core_id", "TEXT", 0], ["safety_core_version", "TEXT", 0],
    ["feedback_rules_version", "TEXT", 0], ["configuration_json", "TEXT", 0],
    ["started_at", "TEXT", 0], ["completed_at", "TEXT", 0],
  ]),
  evaluation_runs: expectedColumns([
    ["evaluation_batch_id", "TEXT", 0], ["pair_key", "TEXT", 0],
    ["profile_id", "TEXT", 0], ["profile_version", "INTEGER", 0],
  ]),
  evaluation_results: expectedColumns([
    ["generation_run_id", "TEXT", 0],
  ]),
};

const expectedEvaluationExportIndexes: readonly ExpectedIndex[] = [
  { name: "idx_evaluation_batches_started", table: "evaluation_batches", columns: ["started_at", "id"] },
  { name: "idx_evaluation_runs_batch_pair", table: "evaluation_runs", columns: ["evaluation_batch_id", "pair_key", "mode", "id"] },
  { name: "ux_evaluation_runs_batch_pair_mode", table: "evaluation_runs", columns: ["evaluation_batch_id", "pair_key", "mode"] },
  { name: "idx_evaluation_runs_profile", table: "evaluation_runs", columns: ["profile_id", "profile_version", "started_at", "id"] },
  { name: "idx_evaluation_results_generation_run", table: "evaluation_results", columns: ["generation_run_id", "created_at", "id"] },
];

const expectedDatasetEvaluationColumns: Record<string, readonly ExpectedTableColumn[]> = {
  feedback_evaluation_results: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["evaluation_batch_id", "TEXT", 0],
    ["generation_run_id", "TEXT", 0], ["dataset_version", "TEXT", 0], ["fixture_id", "TEXT", 0],
    ["fixture_version", "TEXT", 0], ["case_id", "TEXT", 0], ["case_version", "TEXT", 0],
    ["profile_id", "TEXT", 0], ["profile_version", "INTEGER", 0], ["mutation_type", "TEXT", 0],
    ["expected_json", "TEXT", 0], ["observed_json", "TEXT", 0], ["result_status", "TEXT", 0],
    ["rules_version", "TEXT", 0], ["revision_saved", "INTEGER", 0], ["profile_updated", "INTEGER", 0],
    ["created_at", "TEXT", 0],
  ]),
};

const expectedDatasetEvaluationIndexes: readonly ExpectedIndex[] = [
  { name: "idx_feedback_evaluation_results_batch", table: "feedback_evaluation_results", columns: ["evaluation_batch_id", "created_at", "id"] },
  { name: "idx_feedback_evaluation_results_status", table: "feedback_evaluation_results", columns: ["result_status", "created_at", "id"] },
  { name: "idx_feedback_evaluation_results_fixture", table: "feedback_evaluation_results", columns: ["fixture_id", "fixture_version", "created_at", "id"] },
];

const expectedInitialIndexes: readonly ExpectedIndex[] = [
  { name: "idx_generation_runs_case_created", table: "generation_runs", columns: ["case_id", "created_at", "id"] },
  { name: "idx_generation_runs_created", table: "generation_runs", columns: ["created_at", "id"] },
  { name: "idx_draft_revisions_generation_run", table: "draft_revisions", columns: ["generation_run_id", "revision_number"] },
  { name: "idx_feedback_events_generation_run", table: "feedback_events", columns: ["generation_run_id", "created_at", "id"] },
  { name: "idx_review_decisions_feedback_event", table: "review_decisions", columns: ["feedback_event_id", "created_at", "id"] },
  { name: "idx_profile_versions_profile_version", table: "physician_profile_versions", columns: ["profile_id", "version"] },
  { name: "idx_profile_versions_created", table: "physician_profile_versions", columns: ["profile_id", "created_at", "version"] },
  { name: "idx_audit_events_entity_created", table: "audit_events", columns: ["entity_type", "entity_id", "created_at", "id"] },
  { name: "idx_evaluation_results_run", table: "evaluation_results", columns: ["evaluation_run_id", "created_at", "id"] },
];

const expectedEncounterColumns: Record<string, readonly ExpectedTableColumn[]> = {
  encounters: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["synthetic", "INTEGER", 0],
    ["case_id", "TEXT", 0], ["case_version", "TEXT", 0], ["status", "TEXT", 0],
    ["demographic_snapshot_json", "TEXT", 0], ["current_record_revision_id", "TEXT", 0],
    ["created_at", "TEXT", 0], ["updated_at", "TEXT", 0], ["confirmed_at", "TEXT", 0],
    ["runtime_mode", "TEXT", 0],
  ]),
  encounter_record_revisions: expectedColumns([
    ["id", "TEXT", 1], ["encounter_id", "TEXT", 0], ["schema_version", "TEXT", 0],
    ["revision_number", "INTEGER", 0], ["record_payload_json", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
};

const expectedEncounterIndexes: readonly ExpectedIndex[] = [
  { name: "idx_encounters_status_updated", table: "encounters", columns: ["status", "updated_at", "id"] },
  { name: "idx_encounters_case_created", table: "encounters", columns: ["case_id", "case_version", "created_at", "id"] },
  { name: "idx_encounters_runtime_status", table: "encounters", columns: ["runtime_mode", "status", "updated_at", "id"] },
  { name: "idx_encounter_record_revisions_encounter", table: "encounter_record_revisions", columns: ["encounter_id", "revision_number", "created_at", "id"] },
];

const expectedManualSyntheticIntakeColumns: Record<string, readonly ExpectedTableColumn[]> = {
  manual_synthetic_intakes: expectedColumns([
    ["intake_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["creation_request_id", "TEXT", 0],
    ["request_fingerprint", "TEXT", 0], ["synthetic", "INTEGER", 0], ["display_label", "TEXT", 0],
    ["specialty", "TEXT", 0], ["visit_type", "TEXT", 0], ["sex", "TEXT", 0], ["age", "INTEGER", 0],
    ["visit_date", "TEXT", 0], ["record_date", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  encounters: expectedColumns([
    ["source_type", "TEXT", 0], ["manual_intake_id", "TEXT", 0],
  ]),
};

const expectedManualSyntheticIntakeIndexes: readonly ExpectedIndex[] = [
  { name: "ux_manual_synthetic_intakes_creation_request", table: "manual_synthetic_intakes", columns: ["creation_request_id"] },
  { name: "idx_manual_synthetic_intakes_created", table: "manual_synthetic_intakes", columns: ["created_at", "intake_id"] },
  { name: "ux_encounters_manual_intake", table: "encounters", columns: ["manual_intake_id"] },
  { name: "idx_encounters_source_created", table: "encounters", columns: ["source_type", "created_at", "id"] },
];

const expectedLiteratureImportColumns: Record<string, readonly ExpectedTableColumn[]> = {
  literature_import_batches: expectedColumns([
    ["batch_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["request_id", "TEXT", 0],
    ["request_fingerprint", "TEXT", 0], ["status", "TEXT", 0], ["expected_file_count", "INTEGER", 0],
    ["expected_total_bytes", "INTEGER", 0], ["received_file_count", "INTEGER", 0],
    ["received_total_bytes", "INTEGER", 0], ["source_type", "TEXT", 0], ["permission_scope", "TEXT", 0],
    ["created_at", "TEXT", 0], ["updated_at", "TEXT", 0], ["completed_at", "TEXT", 0], ["failure_code", "TEXT", 0],
  ]),
  literature_import_items: expectedColumns([
    ["item_id", "TEXT", 1], ["batch_id", "TEXT", 0], ["schema_version", "TEXT", 0],
    ["client_file_id", "TEXT", 0], ["intent", "TEXT", 0], ["document_id", "TEXT", 0],
    ["expected_current_version", "INTEGER", 0], ["original_filename", "TEXT", 0],
    ["declared_extension", "TEXT", 0], ["declared_mime", "TEXT", 0], ["expected_size_bytes", "INTEGER", 0],
    ["status", "TEXT", 0], ["actual_size_bytes", "INTEGER", 0], ["actual_sha256", "TEXT", 0],
    ["storage_key", "TEXT", 0], ["detected_format", "TEXT", 0], ["detected_mime", "TEXT", 0],
    ["failure_code", "TEXT", 0], ["created_at", "TEXT", 0],
    ["updated_at", "TEXT", 0], ["completed_at", "TEXT", 0],
  ]),
  literature_documents: expectedColumns([
    ["document_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["status", "TEXT", 0],
    ["display_name", "TEXT", 0], ["current_version", "INTEGER", 0], ["current_version_id", "TEXT", 0],
    ["source_type", "TEXT", 0], ["permission_scope", "TEXT", 0], ["created_at", "TEXT", 0],
    ["updated_at", "TEXT", 0], ["disabled_at", "TEXT", 0],
  ]),
  literature_document_versions: expectedColumns([
    ["version_id", "TEXT", 1], ["document_id", "TEXT", 0], ["version_number", "INTEGER", 0],
    ["schema_version", "TEXT", 0], ["format", "TEXT", 0], ["original_filename", "TEXT", 0],
    ["declared_mime", "TEXT", 0], ["detected_mime", "TEXT", 0], ["size_bytes", "INTEGER", 0],
    ["sha256", "TEXT", 0], ["storage_key", "TEXT", 0], ["import_batch_id", "TEXT", 0],
    ["import_item_id", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
};

const expectedLiteratureImportIndexes: readonly ExpectedIndex[] = [
  { name: "idx_literature_import_batches_status_updated", table: "literature_import_batches", columns: ["status", "updated_at", "batch_id"] },
  { name: "idx_literature_import_items_batch_status", table: "literature_import_items", columns: ["batch_id", "status", "created_at", "item_id"] },
  { name: "idx_literature_import_items_sha256", table: "literature_import_items", columns: ["actual_sha256", "status"] },
  { name: "ux_literature_import_items_active_sha256", table: "literature_import_items", columns: ["actual_sha256"] },
  { name: "idx_literature_documents_status_updated", table: "literature_documents", columns: ["status", "updated_at", "document_id"] },
  { name: "idx_literature_versions_document_version", table: "literature_document_versions", columns: ["document_id", "version_number", "created_at", "version_id"] },
  { name: "ux_literature_versions_sha256", table: "literature_document_versions", columns: ["sha256"] },
  { name: "ux_literature_versions_storage_key", table: "literature_document_versions", columns: ["storage_key"] },
];

const expectedLiteratureParsingColumns: Record<string, readonly ExpectedTableColumn[]> = {
  literature_parse_runs: expectedColumns([
    ["parse_run_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["parse_request_id", "TEXT", 0],
    ["request_fingerprint", "TEXT", 0], ["document_id", "TEXT", 0], ["version_id", "TEXT", 0],
    ["parser_version", "TEXT", 0], ["status", "TEXT", 0], ["page_count", "INTEGER", 0],
    ["code_point_count", "INTEGER", 0], ["fragment_count", "INTEGER", 0], ["started_at", "TEXT", 0],
    ["updated_at", "TEXT", 0], ["completed_at", "TEXT", 0], ["failure_code", "TEXT", 0],
  ]),
  literature_pages: expectedColumns([
    ["page_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["parse_run_id", "TEXT", 0], ["document_id", "TEXT", 0],
    ["version_id", "TEXT", 0], ["page_number", "INTEGER", 0], ["source_kind", "TEXT", 0],
    ["text", "TEXT", 0], ["code_point_count", "INTEGER", 0], ["text_sha256", "TEXT", 0],
  ]),
  literature_fragments: expectedColumns([
    ["fragment_id", "TEXT", 1], ["schema_version", "TEXT", 0], ["parse_run_id", "TEXT", 0], ["page_id", "TEXT", 0],
    ["document_id", "TEXT", 0], ["version_id", "TEXT", 0], ["ordinal", "INTEGER", 0],
    ["source_kind", "TEXT", 0], ["page_number", "INTEGER", 0], ["start_code_point", "INTEGER", 0],
    ["end_code_point", "INTEGER", 0], ["start_line", "INTEGER", 0], ["end_line", "INTEGER", 0],
    ["title", "TEXT", 0], ["text", "TEXT", 0], ["normalized_text", "TEXT", 0],
    ["text_sha256", "TEXT", 0],
  ]),
};

const expectedLiteratureParsingIndexes: readonly ExpectedIndex[] = [
  { name: "ux_literature_parse_request", table: "literature_parse_runs", columns: ["parse_request_id"] },
  { name: "ux_literature_parse_active_version", table: "literature_parse_runs", columns: ["version_id"] },
  { name: "ux_literature_parse_ready_version", table: "literature_parse_runs", columns: ["version_id"] },
  { name: "idx_literature_parse_version_status", table: "literature_parse_runs", columns: ["version_id", "status", "updated_at", "parse_run_id"] },
  { name: "idx_literature_pages_run", table: "literature_pages", columns: ["parse_run_id", "page_number", "page_id"] },
  { name: "idx_literature_fragments_run", table: "literature_fragments", columns: ["parse_run_id", "ordinal", "fragment_id"] },
  { name: "idx_literature_fragments_version", table: "literature_fragments", columns: ["version_id", "document_id", "ordinal", "fragment_id"] },
];

const expectedPreSignReviewColumns: Record<string, readonly ExpectedTableColumn[]> = {
  pre_sign_reviews: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["encounter_id", "TEXT", 0],
    ["record_revision_id", "TEXT", 0], ["revision_number", "INTEGER", 0],
    ["ruleset_version", "TEXT", 0], ["items_json", "TEXT", 0],
    ["blocking_count", "INTEGER", 0], ["pending_count", "INTEGER", 0], ["created_at", "TEXT", 0],
  ]),
  review_item_decisions: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["review_id", "TEXT", 0],
    ["item_id", "TEXT", 0], ["decision", "TEXT", 0], ["reason", "TEXT", 0],
    ["actor_id", "TEXT", 0], ["simulated_role", "TEXT", 0], ["created_at", "TEXT", 0],
  ]),
  physician_confirmations: expectedColumns([
    ["id", "TEXT", 1], ["schema_version", "TEXT", 0], ["encounter_id", "TEXT", 0],
    ["review_id", "TEXT", 0], ["record_revision_id", "TEXT", 0], ["revision_number", "INTEGER", 0],
    ["decision_summary_json", "TEXT", 0], ["disclaimer_version", "TEXT", 0],
    ["actor_id", "TEXT", 0], ["simulated_role", "TEXT", 0], ["confirmed_at", "TEXT", 0],
  ]),
};

const expectedPreSignReviewIndexes: readonly ExpectedIndex[] = [
  { name: "idx_pre_sign_reviews_encounter_created", table: "pre_sign_reviews", columns: ["encounter_id", "created_at", "id"] },
  { name: "idx_pre_sign_reviews_revision", table: "pre_sign_reviews", columns: ["record_revision_id", "created_at", "id"] },
  { name: "idx_review_item_decisions_review_created", table: "review_item_decisions", columns: ["review_id", "created_at", "id"] },
  { name: "idx_physician_confirmations_encounter", table: "physician_confirmations", columns: ["encounter_id", "confirmed_at", "id"] },
];

export const runtimeMigrations: readonly RuntimeMigration[] = [
  {
    version: 1,
    name: "0001_initial_runtime_schema",
    sql: initialRuntimeSchemaSql,
    validateStructure: validateRuntimeSchemaV1,
  },
  {
    version: 2,
    name: "0002_feedback_lifecycle",
    sql: feedbackLifecycleMigrationSql,
    validateStructure: validateRuntimeSchemaV2,
  },
  {
    version: 3,
    name: "0003_audit_review_queries",
    sql: auditReviewQueriesMigrationSql,
    validateStructure: validateRuntimeSchemaV3,
  },
  {
    version: 4,
    name: "0004_evaluation_batches",
    sql: evaluationExportMigrationSql,
    validateStructure: validateRuntimeSchemaV4,
  },
  {
    version: 5,
    name: "0005_dataset_evaluation",
    sql: datasetEvaluationMigrationSql,
    validateStructure: validateRuntimeSchemaV5,
  },
  {
    version: 6,
    name: "0006_provider_foundation",
    sql: providerFoundationMigrationSql,
    validateStructure: validateRuntimeSchemaV6,
  },
  {
    version: 7,
    name: "0007_physician_encounter_workflow",
    sql: encounterWorkflowMigrationSql,
    validateStructure: validateRuntimeSchemaV7,
  },
  {
    version: 8,
    name: "0008_pre_sign_review_and_confirmation",
    sql: preSignReviewMigrationSql,
    validateStructure: validateRuntimeSchemaV8,
  },
  {
    version: 9,
    name: "0009_manual_synthetic_intake",
    sql: manualSyntheticIntakeMigrationSql,
    validateStructure: validateRuntimeSchemaV9,
  },
  {
    version: 10,
    name: "0010_literature_import_storage",
    sql: literatureImportStorageMigrationSql,
    validateStructure: validateRuntimeSchemaV10,
  },
  {
    version: 11,
    name: "0011_literature_parsing_retrieval",
    sql: literatureParsingMigrationSql,
    validateStructure: validateRuntimeSchemaV11,
  },
  {
    version: 12,
    name: "0012_model_reference_results",
    sql: modelReferenceContractsMigrationSql,
    validateStructure: validateRuntimeSchemaV12,
  },
];

export function migrationChecksum(migration: RuntimeMigration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName) as { present?: number } | undefined;
  return row?.present === 1;
}

function readSchemaMigrationColumns(database: DatabaseSync): string[] {
  const rows = database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{
    name?: string;
    type?: string;
    notnull?: number;
    pk?: number;
  }>;
  const expected = [
    { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "checksum", type: "TEXT", notnull: 1, pk: 0 },
    { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 },
  ];
  if (rows.length !== expected.length) return [];
  const matches = rows.every((row, index) => {
    const expectedColumn = expected[index];
    return row.name === expectedColumn.name
      && row.type === expectedColumn.type
      && row.notnull === expectedColumn.notnull
      && row.pk === expectedColumn.pk;
  });
  return matches ? expected.map((column) => column.name) : [];
}

function assertSchemaMigrationTable(database: DatabaseSync): void {
  const columns = readSchemaMigrationColumns(database);
  const expected = ["version", "name", "checksum", "applied_at"];
  if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "schema_migrations structure is not managed by this runtime.",
    );
  }
}

function assertMigrationRegistry(migrations: readonly RuntimeMigration[]): void {
  const versions = migrations.map((migration) => migration.version);
  const hasInvalidVersion = versions.some((version) => !Number.isInteger(version) || version <= 0);
  const hasInvalidOrder = versions.some((version, index) => version !== index + 1);
  const hasInvalidName = migrations.some((migration) => {
    const expectedPrefix = `${String(migration.version).padStart(4, "0")}_`;
    return migration.version > 9999
      || !/^\d{4}_[a-z0-9_]+$/.test(migration.name)
      || !migration.name.startsWith(expectedPrefix);
  });
  const hasMissingStructureValidator = migrations.some(
    (migration) => typeof migration.validateStructure !== "function",
  );

  if (migrations.length === 0 || hasInvalidVersion || hasInvalidOrder || hasInvalidName || hasMissingStructureValidator) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Runtime migration registry is invalid.",
    );
  }
}

function assertNoUnmanagedBusinessTables(database: DatabaseSync): void {
  const managedTableNames = [
    "generation_runs",
    "draft_revisions",
    "feedback_events",
    "review_decisions",
    "physician_profile_versions",
    "audit_events",
    "evaluation_batches",
    "evaluation_runs",
    "evaluation_results",
    "feedback_evaluation_results",
    "encounters",
    "encounter_record_revisions",
    "pre_sign_reviews",
    "review_item_decisions",
    "physician_confirmations",
    "manual_synthetic_intakes",
    "literature_import_batches",
    "literature_import_items",
    "literature_documents",
    "literature_document_versions",
  ];
  const existingTables = managedTableNames.filter((tableName) => tableExists(database, tableName));
  if (existingTables.length > 0) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Existing runtime tables have no managed migration history.",
    );
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Migration structure contains an unsafe identifier.",
    );
  }
  return `"${identifier}"`;
}

export function validateRuntimeSchemaBase(database: DatabaseSync, exactColumns: boolean): void {
  for (const [tableName, expectedColumns] of Object.entries(expectedInitialTableColumns)) {
    if (!tableExists(database, tableName)) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Managed runtime table is missing from the applied migration.",
      );
    }

    const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
      name?: string;
      type?: string;
      pk?: number;
    }>;
    const matches = exactColumns
      ? rows.length === expectedColumns.length && rows.every((row, index) => {
          const expected = expectedColumns[index];
          return row.name === expected.name && row.type === expected.type && row.pk === expected.primaryKeyPosition;
        })
      : expectedColumns.every((expected) => rows.some(
          (row) => row.name === expected.name
            && row.type === expected.type
            && row.pk === expected.primaryKeyPosition,
        ));
    if (!matches) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Managed runtime table structure does not match the applied migration.",
      );
    }
  }

  for (const expectedIndex of expectedInitialIndexes) {
    const indexRow = database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(expectedIndex.name) as { tbl_name?: string } | undefined;
    if (indexRow?.tbl_name !== expectedIndex.table) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Managed runtime index is missing or attached to the wrong table.",
      );
    }

    const indexColumns = database.prepare(
      `PRAGMA index_info(${quoteIdentifier(expectedIndex.name)})`,
    ).all() as Array<{ seqno?: number; name?: string }>;
    const actualColumns = indexColumns
      .sort((left, right) => (left.seqno ?? 0) - (right.seqno ?? 0))
      .map((column) => column.name);
    if (actualColumns.length !== expectedIndex.columns.length
      || actualColumns.some((column, index) => column !== expectedIndex.columns[index])) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Managed runtime index columns do not match the applied migration.",
      );
    }
  }

  const triggerRows = database.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)",
  ).all("audit_events_no_delete", "audit_events_no_update") as Array<{
    name?: string;
    tbl_name?: string;
    sql?: string;
  }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row]));
  const expectedTriggers: Array<[string, string]> = [
    ["audit_events_no_delete", "BEFORE DELETE ON AUDIT_EVENTS"],
    ["audit_events_no_update", "BEFORE UPDATE ON AUDIT_EVENTS"],
  ];
  if (expectedTriggers.some(([name, sqlFragment]) => {
    const trigger = triggerByName.get(name);
    return trigger?.tbl_name !== "audit_events"
      || typeof trigger.sql !== "string"
      || !trigger.sql.toUpperCase().includes(sqlFragment)
      || !trigger.sql.toUpperCase().includes("RAISE(ABORT");
  })) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Append-only audit triggers are missing from the applied migration.",
    );
  }
}

export function validateRuntimeSchemaV1(database: DatabaseSync): void {
  validateRuntimeSchemaBase(database, true);
}

const expectedFeedbackLifecycleColumns: Record<string, readonly ExpectedTableColumn[]> = {
  feedback_events: expectedColumns([
    ["draft_revision_id", "TEXT", 0], ["revision_number", "INTEGER", 0], ["proposal_id", "TEXT", 0],
    ["profile_id", "TEXT", 0], ["profile_version", "INTEGER", 0], ["rules_version", "TEXT", 0],
    ["change_type", "TEXT", 0], ["affected_field", "TEXT", 0], ["safety_reason", "TEXT", 0],
    ["next_allowed_actions_json", "TEXT", 0], ["evidence_json", "TEXT", 0], ["candidate_patch_json", "TEXT", 0],
    ["decision", "TEXT", 0],
  ]),
  review_decisions: expectedColumns([
    ["expected_profile_version", "INTEGER", 0],
  ]),
};

const expectedFeedbackLifecycleIndexes: readonly ExpectedIndex[] = [
  { name: "idx_feedback_events_draft_revision", table: "feedback_events", columns: ["draft_revision_id", "created_at", "id"] },
  { name: "idx_feedback_events_status_risk", table: "feedback_events", columns: ["status", "risk_level", "created_at", "id"] },
  { name: "idx_feedback_events_profile", table: "feedback_events", columns: ["profile_id", "profile_version", "created_at", "id"] },
  { name: "ux_review_decisions_feedback_event", table: "review_decisions", columns: ["feedback_event_id"] },
];

const expectedAuditReviewQueryIndexes: readonly ExpectedIndex[] = [
  { name: "idx_audit_events_type_created", table: "audit_events", columns: ["event_type", "created_at", "id"] },
  { name: "idx_audit_events_role_created", table: "audit_events", columns: ["simulated_role", "created_at", "id"] },
];

function validateExpectedColumns(
  database: DatabaseSync,
  expectedByTable: Record<string, readonly ExpectedTableColumn[]>,
): void {
  for (const [tableName, expectedColumnsForTable] of Object.entries(expectedByTable)) {
    const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
      name?: string;
      type?: string;
      pk?: number;
    }>;
    if (expectedColumnsForTable.some((expected) => !rows.some(
      (row) => row.name === expected.name
        && row.type === expected.type
        && row.pk === expected.primaryKeyPosition,
    ))) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Feedback lifecycle table structure does not match the applied migration.",
      );
    }
  }
}

function validateExpectedIndexes(database: DatabaseSync, expectedIndexes: readonly ExpectedIndex[]): void {
  for (const expectedIndex of expectedIndexes) {
    const indexRow = database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(expectedIndex.name) as { tbl_name?: string } | undefined;
    if (indexRow?.tbl_name !== expectedIndex.table) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Feedback lifecycle index is missing or attached to the wrong table.",
      );
    }
    const indexColumns = database.prepare(
      `PRAGMA index_info(${quoteIdentifier(expectedIndex.name)})`,
    ).all() as Array<{ seqno?: number; name?: string }>;
    const actualColumns = indexColumns
      .sort((left, right) => (left.seqno ?? 0) - (right.seqno ?? 0))
      .map((column) => column.name);
    if (actualColumns.length !== expectedIndex.columns.length
      || actualColumns.some((column, index) => column !== expectedIndex.columns[index])) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Feedback lifecycle index columns do not match the applied migration.",
      );
    }
  }
}

export function validateRuntimeSchemaV2(database: DatabaseSync): void {
  validateRuntimeSchemaBase(database, false);
  validateExpectedColumns(database, expectedFeedbackLifecycleColumns);
  validateExpectedIndexes(database, expectedFeedbackLifecycleIndexes);
  const uniqueIndex = database.prepare(
    "PRAGMA index_list(\"review_decisions\")",
  ).all() as Array<{ name?: string; unique?: number }>;
  if (!uniqueIndex.some((index) => index.name === "ux_review_decisions_feedback_event" && index.unique === 1)) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Each feedback event must have at most one review decision.",
    );
  }
  const v2AlreadyApplied = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = 2 LIMIT 1",
  ).get();
  if (!v2AlreadyApplied) {
    const legacyPlaceholder = database.prepare(
      `SELECT id FROM feedback_events
       WHERE proposal_id = 'legacy-proposal' OR profile_id = 'legacy-profile'
       LIMIT 1`,
    ).get() as { id?: string } | undefined;
    const legacyReview = database.prepare(
      "SELECT id FROM review_decisions LIMIT 1",
    ).get() as { id?: string } | undefined;
    if (legacyPlaceholder || legacyReview) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Untrusted pre-feedback-lifecycle rows cannot be upgraded.",
      );
    }
  }
}

export function validateRuntimeSchemaV3(database: DatabaseSync): void {
  validateRuntimeSchemaV2(database);
  validateExpectedIndexes(database, expectedAuditReviewQueryIndexes);
}

export function validateRuntimeSchemaV4(database: DatabaseSync): void {
  validateRuntimeSchemaV3(database);
  validateExpectedColumns(database, expectedEvaluationBatchColumns);
  validateExpectedIndexes(database, expectedEvaluationExportIndexes);

  const batchTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evaluation_batches'",
  ).get() as { sql?: string } | undefined;
  if (typeof batchTableSql?.sql !== "string"
    || !batchTableSql.sql.includes("RUNNING")
    || !batchTableSql.sql.includes("PARTIAL_FAILURE")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Evaluation batch status constraints are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV5(database: DatabaseSync): void {
  validateRuntimeSchemaV4(database);
  validateExpectedColumns(database, expectedDatasetEvaluationColumns);
  validateExpectedIndexes(database, expectedDatasetEvaluationIndexes);
  const resultTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feedback_evaluation_results'",
  ).get() as { sql?: string } | undefined;
  if (typeof resultTableSql?.sql !== "string"
    || !resultTableSql.sql.includes("result_status IN ('PASS', 'FAIL')")
    || !resultTableSql.sql.includes("UNIQUE (evaluation_batch_id, fixture_id, fixture_version)")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Dataset feedback evaluation result constraints are missing from the managed schema.",
    );
  }
}

function hasColumn(database: DatabaseSync, tableName: string, columnName: string, type: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
    name?: string;
    type?: string;
  }>;
  return rows.some((row) => row.name === columnName && row.type === type);
}

function hasIndex(database: DatabaseSync, indexName: string, tableName: string, columns: readonly string[]): boolean {
  const row = database.prepare(
    "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(indexName) as { tbl_name?: string } | undefined;
  if (row?.tbl_name !== tableName) return false;
  const actual = (database.prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`).all() as Array<{ seqno?: number; name?: string }>)
    .sort((left, right) => (left.seqno ?? 0) - (right.seqno ?? 0))
    .map((column) => column.name);
  return actual.length === columns.length && actual.every((column, index) => column === columns[index]);
}

export function validateRuntimeSchemaV6(database: DatabaseSync): void {
  validateRuntimeSchemaV5(database);
  if (!hasColumn(database, "generation_runs", "provider_metadata_json", "TEXT")
    || !hasColumn(database, "evaluation_batches", "execution_type", "TEXT")
    || !hasColumn(database, "evaluation_runs", "execution_type", "TEXT")
    || !hasIndex(database, "idx_evaluation_batches_execution_type", "evaluation_batches", ["execution_type", "started_at", "id"])
    || !hasIndex(database, "idx_evaluation_runs_execution_type", "evaluation_runs", ["execution_type", "started_at", "id"])) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Provider foundation columns or indexes are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV7(database: DatabaseSync): void {
  validateRuntimeSchemaV6(database);
  validateExpectedColumns(database, expectedEncounterColumns);
  validateExpectedIndexes(database, expectedEncounterIndexes);

  const encounterTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'encounters'",
  ).get() as { sql?: string } | undefined;
  const revisionTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'encounter_record_revisions'",
  ).get() as { sql?: string } | undefined;
  const normalizedEncounterSql = encounterTableSql?.sql?.replace(/\s+/gu, " ").toUpperCase();
  const normalizedRevisionSql = revisionTableSql?.sql?.replace(/\s+/gu, " ").toUpperCase();
  const requiredEncounterFragments = [
    "SYNTHETIC INTEGER NOT NULL CHECK (SYNTHETIC = 1)",
    "STATUS TEXT NOT NULL CHECK (STATUS IN ('DRAFT', 'RECORD_SAVED', 'REFERENCE_VIEWED', 'REVIEW_PENDING', 'CONFIRMED'))",
    "RUNTIME_MODE TEXT NOT NULL CHECK (RUNTIME_MODE IN ('PUBLIC-DEMO', 'LOCAL-RESEARCH'))",
    "CHECK (STATUS = 'DRAFT' OR CURRENT_RECORD_REVISION_ID IS NOT NULL)",
    "CURRENT_RECORD_REVISION_ID TEXT REFERENCES ENCOUNTER_RECORD_REVISIONS(ID)",
  ];
  if (typeof normalizedEncounterSql !== "string"
    || requiredEncounterFragments.some((fragment) => !normalizedEncounterSql.includes(fragment))
    || typeof normalizedRevisionSql !== "string"
    || !normalizedRevisionSql.includes("UNIQUE (ENCOUNTER_ID, REVISION_NUMBER)")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Encounter workflow constraints are missing from the managed schema.",
    );
  }

  const encounterForeignKeys = database.prepare(
    "PRAGMA foreign_key_list(\"encounters\")",
  ).all() as Array<{ table?: string; from?: string; to?: string }>;
  const revisionForeignKeys = database.prepare(
    "PRAGMA foreign_key_list(\"encounter_record_revisions\")",
  ).all() as Array<{ table?: string; from?: string; to?: string }>;
  if (!encounterForeignKeys.some((foreignKey) => (
    foreignKey.table === "encounter_record_revisions"
    && foreignKey.from === "current_record_revision_id"
    && foreignKey.to === "id"
  )) || !revisionForeignKeys.some((foreignKey) => (
    foreignKey.table === "encounters"
    && foreignKey.from === "encounter_id"
    && foreignKey.to === "id"
  ))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Encounter workflow foreign-key relationships are missing from the managed schema.",
    );
  }

  const triggerRows = database.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?, ?)",
  ).all(
    "encounter_record_revisions_no_update",
    "encounter_record_revisions_no_delete",
    "encounters_current_revision_matches_insert",
    "encounters_current_revision_matches_update",
  ) as Array<{ name?: string; tbl_name?: string; sql?: string }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row]));
  const immutableTriggers = [
    ["encounter_record_revisions_no_update", "BEFORE UPDATE ON ENCOUNTER_RECORD_REVISIONS"],
    ["encounter_record_revisions_no_delete", "BEFORE DELETE ON ENCOUNTER_RECORD_REVISIONS"],
  ] as const;
  const relationTriggers = [
    ["encounters_current_revision_matches_insert", "AFTER INSERT ON ENCOUNTERS"],
    ["encounters_current_revision_matches_update", "AFTER UPDATE OF CURRENT_RECORD_REVISION_ID ON ENCOUNTERS"],
  ] as const;
  if ([...immutableTriggers, ...relationTriggers].some(([name, fragment]) => {
    const trigger = triggerByName.get(name);
    return trigger?.sql === undefined || !trigger.sql.toUpperCase().includes(fragment);
  })) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Encounter workflow immutability or relation triggers are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV8(database: DatabaseSync): void {
  validateRuntimeSchemaV7(database);
  validateExpectedColumns(database, expectedPreSignReviewColumns);
  validateExpectedIndexes(database, expectedPreSignReviewIndexes);

  const tableSql = new Map(
    (database.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
    ).all(
      "pre_sign_reviews",
      "review_item_decisions",
      "physician_confirmations",
    ) as Array<{ name?: string; sql?: string }>).map((row) => [row.name, row.sql]),
  );
  const reviewSql = tableSql.get("pre_sign_reviews")?.replace(/\s+/gu, " ").toUpperCase();
  const decisionSql = tableSql.get("review_item_decisions")?.replace(/\s+/gu, " ").toUpperCase();
  const confirmationSql = tableSql.get("physician_confirmations")?.replace(/\s+/gu, " ").toUpperCase();
  if (typeof reviewSql !== "string"
    || !reviewSql.includes("UNIQUE (ENCOUNTER_ID, RECORD_REVISION_ID)")
    || typeof decisionSql !== "string"
    || !decisionSql.includes("UNIQUE (REVIEW_ID, ITEM_ID)")
    || typeof confirmationSql !== "string"
    || !confirmationSql.includes("UNIQUE (ENCOUNTER_ID)")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Pre-sign review uniqueness constraints are missing from the managed schema.",
    );
  }

  const foreignKeys = [
    ["pre_sign_reviews", "encounters", "encounter_id", "id"],
    ["pre_sign_reviews", "encounter_record_revisions", "record_revision_id", "id"],
    ["review_item_decisions", "pre_sign_reviews", "review_id", "id"],
    ["physician_confirmations", "encounters", "encounter_id", "id"],
    ["physician_confirmations", "pre_sign_reviews", "review_id", "id"],
    ["physician_confirmations", "encounter_record_revisions", "record_revision_id", "id"],
  ] as const;
  for (const [table, referencedTable, from, to] of foreignKeys) {
    const rows = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{
      table?: string;
      from?: string;
      to?: string;
    }>;
    if (!rows.some((foreignKey) => foreignKey.table === referencedTable
      && foreignKey.from === from
      && foreignKey.to === to)) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Pre-sign review foreign-key relationships are missing from the managed schema.",
      );
    }
  }

  const triggerNames = [
    "pre_sign_reviews_revision_matches_encounter",
    "physician_confirmations_binding_matches_encounter",
    "pre_sign_reviews_no_update",
    "pre_sign_reviews_no_delete",
    "review_item_decisions_no_update",
    "review_item_decisions_no_delete",
    "physician_confirmations_no_update",
    "physician_confirmations_no_delete",
  ];
  const triggerRows = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`,
  ).all(...triggerNames) as Array<{ name?: string; sql?: string }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row.sql]));
  if (triggerNames.some((name) => typeof triggerByName.get(name) !== "string")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Pre-sign review immutability or binding triggers are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV9(database: DatabaseSync): void {
  validateRuntimeSchemaV8(database);
  validateExpectedColumns(database, expectedManualSyntheticIntakeColumns);
  validateExpectedIndexes(database, expectedManualSyntheticIntakeIndexes);

  const manualIntakeTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manual_synthetic_intakes'",
  ).get() as { sql?: string } | undefined;
  const encounterTableSql = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'encounters'",
  ).get() as { sql?: string } | undefined;
  const normalizedManualIntakeSql = manualIntakeTableSql?.sql?.replace(/\s+/gu, " ").toUpperCase();
  const normalizedEncounterSql = encounterTableSql?.sql?.replace(/\s+/gu, " ").toUpperCase();
  const requiredManualIntakeFragments = [
    "SCHEMA_VERSION TEXT NOT NULL CHECK (SCHEMA_VERSION = '1.0.0')",
    "SYNTHETIC INTEGER NOT NULL CHECK (SYNTHETIC = 1)",
    "SPECIALTY TEXT NOT NULL CHECK (SPECIALTY IN ('普通内科', '内分泌科'))",
    "VISIT_TYPE TEXT NOT NULL CHECK (VISIT_TYPE IN ('初诊', '慢病复诊'))",
    "SEX TEXT NOT NULL CHECK (SEX IN ('FEMALE', 'MALE', 'INTERSEX'))",
    "AGE INTEGER NOT NULL CHECK (AGE BETWEEN 0 AND 150)",
    "CHECK (RECORD_DATE >= VISIT_DATE)",
  ];
  const requiredEncounterFragments = [
    "SOURCE_TYPE TEXT NOT NULL DEFAULT 'SEEDED_SYNTHETIC' CHECK (SOURCE_TYPE IN ('SEEDED_SYNTHETIC', 'MANUAL_SYNTHETIC'))",
    "MANUAL_INTAKE_ID TEXT REFERENCES MANUAL_SYNTHETIC_INTAKES(INTAKE_ID)",
  ];
  if (typeof normalizedManualIntakeSql !== "string"
    || requiredManualIntakeFragments.some((fragment) => !normalizedManualIntakeSql.includes(fragment))
    || typeof normalizedEncounterSql !== "string"
    || requiredEncounterFragments.some((fragment) => !normalizedEncounterSql.includes(fragment))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Manual synthetic intake constraints are missing from the managed schema.",
    );
  }

  const uniqueIndexes = new Map(
    (database.prepare("PRAGMA index_list(\"manual_synthetic_intakes\")").all() as Array<{ name?: string; unique?: number }>)
      .map((index) => [index.name, index.unique]),
  );
  const encounterUniqueIndexes = new Map(
    (database.prepare("PRAGMA index_list(\"encounters\")").all() as Array<{ name?: string; unique?: number }>)
      .map((index) => [index.name, index.unique]),
  );
  if (uniqueIndexes.get("ux_manual_synthetic_intakes_creation_request") !== 1
    || encounterUniqueIndexes.get("ux_encounters_manual_intake") !== 1) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Manual synthetic intake idempotency or one-to-one indexes are missing from the managed schema.",
    );
  }

  const encounterForeignKeys = database.prepare(
    "PRAGMA foreign_key_list(\"encounters\")",
  ).all() as Array<{ table?: string; from?: string; to?: string }>;
  if (!encounterForeignKeys.some((foreignKey) => (
    foreignKey.table === "manual_synthetic_intakes"
    && foreignKey.from === "manual_intake_id"
    && foreignKey.to === "intake_id"
  ))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Manual synthetic intake foreign-key binding is missing from the managed schema.",
    );
  }

  const triggerNames = [
    "manual_synthetic_intakes_no_update",
    "manual_synthetic_intakes_no_delete",
    "encounters_source_binding_insert",
    "encounters_source_binding_update",
  ];
  const triggerRows = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`,
  ).all(...triggerNames) as Array<{ name?: string; sql?: string }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  const requiredTriggers: Array<[string, string]> = [
    ["manual_synthetic_intakes_no_update", "BEFORE UPDATE ON MANUAL_SYNTHETIC_INTAKES"],
    ["manual_synthetic_intakes_no_delete", "BEFORE DELETE ON MANUAL_SYNTHETIC_INTAKES"],
    ["encounters_source_binding_insert", "BEFORE INSERT ON ENCOUNTERS"],
    ["encounters_source_binding_update", "BEFORE UPDATE OF SOURCE_TYPE, MANUAL_INTAKE_ID ON ENCOUNTERS"],
  ];
  if (requiredTriggers.some(([name, fragment]) => {
    const sql = triggerByName.get(name);
    return typeof sql !== "string" || !sql.includes(fragment);
  })) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Manual synthetic intake immutability or source-binding triggers are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV10(database: DatabaseSync): void {
  validateRuntimeSchemaV9(database);
  validateExpectedColumns(database, expectedLiteratureImportColumns);
  validateExpectedIndexes(database, expectedLiteratureImportIndexes);

  const tableRows = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)",
  ).all(
    "literature_import_batches",
    "literature_import_items",
    "literature_documents",
    "literature_document_versions",
  ) as Array<{ name?: string; sql?: string }>;
  const tableSql = new Map(tableRows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  const requiredFragments: Array<[string, string]> = [
    ["literature_import_batches", "REQUEST_ID TEXT NOT NULL"],
    ["literature_import_batches", "EXPECTED_FILE_COUNT INTEGER NOT NULL CHECK (EXPECTED_FILE_COUNT BETWEEN 1 AND 3)"],
    ["literature_import_items", "UNIQUE (BATCH_ID, CLIENT_FILE_ID)"],
    ["literature_import_items", "EXPECTED_SIZE_BYTES INTEGER NOT NULL CHECK (EXPECTED_SIZE_BYTES BETWEEN 1 AND 104857600)"],
    ["literature_import_items", "DETECTED_FORMAT TEXT CHECK (DETECTED_FORMAT IS NULL OR DETECTED_FORMAT IN ('PDF', 'UTF8_TEXT'))"],
    ["literature_import_items", "STATUS = 'VALIDATED' AND ACTUAL_SIZE_BYTES IS NOT NULL AND ACTUAL_SHA256 IS NOT NULL AND STORAGE_KEY IS NOT NULL AND DETECTED_FORMAT IS NOT NULL AND DETECTED_MIME IS NOT NULL AND COMPLETED_AT IS NULL"],
    ["literature_import_items", "STATUS = 'AVAILABLE' AND ACTUAL_SIZE_BYTES IS NOT NULL AND ACTUAL_SHA256 IS NOT NULL AND STORAGE_KEY IS NOT NULL AND DETECTED_FORMAT IS NOT NULL AND DETECTED_MIME IS NOT NULL AND COMPLETED_AT IS NOT NULL"],
    ["literature_import_items", "STATUS IN ('RESERVED', 'UPLOADING') AND ACTUAL_SIZE_BYTES IS NULL AND ACTUAL_SHA256 IS NULL AND STORAGE_KEY IS NULL"],
    ["literature_documents", "CURRENT_VERSION INTEGER NOT NULL CHECK (CURRENT_VERSION >= 1)"],
    ["literature_document_versions", "UNIQUE (DOCUMENT_ID, VERSION_NUMBER)"],
    ["literature_document_versions", "UNIQUE (SHA256)"],
    ["literature_document_versions", "UNIQUE (STORAGE_KEY)"],
  ];
  if (requiredFragments.some(([table, fragment]) => !tableSql.get(table)?.includes(fragment))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature import storage constraints are missing from the managed schema.",
    );
  }

  const activeShaIndex = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get("ux_literature_import_items_active_sha256") as { name?: string; sql?: string } | undefined;
  const normalizedActiveShaIndexSql = activeShaIndex?.sql?.replace(/\s+/gu, " ").toUpperCase();
  if (activeShaIndex?.name !== "ux_literature_import_items_active_sha256"
    || typeof normalizedActiveShaIndexSql !== "string"
    || !normalizedActiveShaIndexSql.includes("UNIQUE INDEX UX_LITERATURE_IMPORT_ITEMS_ACTIVE_SHA256 ON LITERATURE_IMPORT_ITEMS (ACTUAL_SHA256)")
    || !normalizedActiveShaIndexSql.includes("WHERE ACTUAL_SHA256 IS NOT NULL AND STATUS IN ('VALIDATED', 'AVAILABLE')")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature validated-content uniqueness is missing from the managed schema.",
    );
  }

  const foreignKeys: Array<[string, string, string, string]> = [
    ["literature_import_items", "literature_import_batches", "batch_id", "batch_id"],
    ["literature_import_items", "literature_documents", "document_id", "document_id"],
    ["literature_documents", "literature_document_versions", "current_version_id", "version_id"],
    ["literature_document_versions", "literature_documents", "document_id", "document_id"],
    ["literature_document_versions", "literature_import_batches", "import_batch_id", "batch_id"],
    ["literature_document_versions", "literature_import_items", "import_item_id", "item_id"],
  ];
  for (const [table, referencedTable, from, to] of foreignKeys) {
    const rows = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{
      table?: string;
      from?: string;
      to?: string;
    }>;
    if (!rows.some((foreignKey) => foreignKey.table === referencedTable
      && foreignKey.from === from
      && foreignKey.to === to)) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Literature import storage foreign-key relationships are missing from the managed schema.",
      );
    }
  }

  const triggerNames = [
    "literature_document_versions_no_update",
    "literature_document_versions_no_delete",
    "literature_documents_current_version_matches_insert",
    "literature_documents_current_version_matches_update",
  ];
  const triggerRows = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`,
  ).all(...triggerNames) as Array<{ name?: string; sql?: string }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  const triggerFragments: Array<[string, string]> = [
    ["literature_document_versions_no_update", "BEFORE UPDATE ON LITERATURE_DOCUMENT_VERSIONS"],
    ["literature_document_versions_no_delete", "BEFORE DELETE ON LITERATURE_DOCUMENT_VERSIONS"],
    ["literature_documents_current_version_matches_insert", "AFTER INSERT ON LITERATURE_DOCUMENTS"],
    ["literature_documents_current_version_matches_update", "AFTER UPDATE OF CURRENT_VERSION, CURRENT_VERSION_ID ON LITERATURE_DOCUMENTS"],
  ];
  if (triggerFragments.some(([name, fragment]) => !triggerByName.get(name)?.includes(fragment))
    || !triggerByName.get("literature_documents_current_version_matches_insert")?.includes("VERSION_NUMBER = NEW.CURRENT_VERSION")
    || !triggerByName.get("literature_documents_current_version_matches_insert")?.includes("DOCUMENT_ID = NEW.DOCUMENT_ID")
    || !triggerByName.get("literature_documents_current_version_matches_insert")?.includes("RAISE(ABORT")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature import storage immutability or binding triggers are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV11(database: DatabaseSync): void {
  validateRuntimeSchemaV10(database);
  validateExpectedColumns(database, expectedLiteratureParsingColumns);
  validateExpectedIndexes(database, expectedLiteratureParsingIndexes);

  const tableRows = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)",
  ).all(
    "literature_parse_runs",
    "literature_pages",
    "literature_fragments",
    "literature_fragments_fts",
  ) as Array<{ name?: string; sql?: string }>;
  const tableSql = new Map(tableRows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  const requiredTables = ["literature_parse_runs", "literature_pages", "literature_fragments", "literature_fragments_fts"];
  if (requiredTables.some((table) => typeof tableSql.get(table) !== "string")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature parsing tables are missing from the managed schema.",
    );
  }
  const requiredFragments: Array<[string, string]> = [
    ["literature_parse_runs", "STATUS IN ('PENDING', 'PARSING', 'READY', 'FAILED')"],
    ["literature_parse_runs", "UNIQUE (PARSE_REQUEST_ID)"],
    ["literature_pages", "UNIQUE (PARSE_RUN_ID, PAGE_NUMBER)"],
    ["literature_fragments", "UNIQUE (PARSE_RUN_ID, ORDINAL)"],
    ["literature_fragments_fts", "USING FTS5"],
    ["literature_fragments_fts", "TOKENIZE = 'TRIGRAM'"],
  ];
  if (requiredFragments.some(([table, fragment]) => !tableSql.get(table)?.includes(fragment))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature parsing constraints or FTS5 configuration are missing from the managed schema.",
    );
  }

  const triggerNames = [
    "literature_pages_binding_insert",
    "literature_fragments_binding_insert",
    "literature_fragments_fts_insert",
    "literature_fragments_fts_delete",
  ];
  const triggerRows = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`,
  ).all(...triggerNames) as Array<{ name?: string; sql?: string }>;
  const triggerByName = new Map(triggerRows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  if (!triggerByName.get("literature_pages_binding_insert")?.includes("BEFORE INSERT ON LITERATURE_PAGES")
    || !triggerByName.get("literature_fragments_binding_insert")?.includes("BEFORE INSERT ON LITERATURE_FRAGMENTS")
    || !triggerByName.get("literature_fragments_fts_insert")?.includes("AFTER INSERT ON LITERATURE_FRAGMENTS")
    || !triggerByName.get("literature_fragments_fts_delete")?.includes("AFTER DELETE ON LITERATURE_FRAGMENTS")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Literature fragment FTS maintenance triggers are missing from the managed schema.",
    );
  }
}

export function validateRuntimeSchemaV12(database: DatabaseSync): void {
  validateRuntimeSchemaV11(database);
  const requiredTables = [
    "model_reference_runs",
    "model_reference_items",
    "model_reference_supports",
    "model_reference_followups",
  ];
  const rows = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(", ")})`,
  ).all(...requiredTables) as Array<{ name?: string; sql?: string }>;
  const tables = new Map(rows.map((row) => [row.name, row.sql?.replace(/\s+/gu, " ").toUpperCase()]));
  if (requiredTables.some((name) => typeof tables.get(name) !== "string")
    || !tables.get("model_reference_runs")?.includes("UNIQUE (REFERENCE_REQUEST_ID)")
    || !tables.get("model_reference_runs")?.includes("STATUS IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'STALE')")
    || !tables.get("model_reference_items")?.includes("UNIQUE (REFERENCE_ID, ORDINAL)")
    || !tables.get("model_reference_followups")?.includes("UNIQUE (REFERENCE_ID, ITEM_ID)")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Offline model-reference contract tables are missing required constraints.",
    );
  }
  const triggerNames = [
    "model_reference_items_no_update",
    "model_reference_items_no_delete",
    "model_reference_supports_no_update",
    "model_reference_supports_no_delete",
    "model_reference_followups_no_update",
    "model_reference_followups_no_delete",
  ];
  const triggers = database.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => "?").join(", ")})`,
  ).all(...triggerNames) as Array<{ name?: string; sql?: string }>;
  if (triggers.length !== triggerNames.length || triggers.some((trigger) => !trigger.sql?.toUpperCase().includes("RAISE(ABORT"))) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Offline model-reference immutable snapshot triggers are missing from the managed schema.",
    );
  }
  const indexes = [
    "idx_model_reference_runs_encounter_created",
    "idx_model_reference_items_reference",
    "idx_model_reference_followups_encounter_status",
  ];
  const indexRows = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${indexes.map(() => "?").join(", ")})`,
  ).all(...indexes) as Array<{ name?: string }>;
  if (indexRows.length !== indexes.length) {
    throw new PersistenceError(persistenceErrorCodes.MIGRATION_DRIFT, "Offline model-reference indexes are missing.");
  }
}

type AppliedMigrationRow = {
  version?: number;
  name?: string;
  checksum?: string;
};

function readAppliedMigrations(database: DatabaseSync): AppliedMigrationRow[] {
  return database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
  ).all() as AppliedMigrationRow[];
}

function assertAppliedMigrations(
  appliedRows: readonly AppliedMigrationRow[],
  migrations: readonly RuntimeMigration[],
): Set<number> {
  const expectedByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set<number>();

  for (const row of appliedRows) {
    if (row.version === undefined || row.name === undefined || row.checksum === undefined) {
      throw new PersistenceError(persistenceErrorCodes.MIGRATION_DRIFT, "Migration history contains an invalid row.");
    }
    const migration = expectedByVersion.get(row.version);
    if (!migration || migration.name !== row.name || migrationChecksum(migration) !== row.checksum) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Applied migration history does not match the runtime registry.",
      );
    }
    appliedVersions.add(row.version);
  }

  const sortedAppliedVersions = [...appliedVersions].sort((left, right) => left - right);
  for (let index = 0; index < sortedAppliedVersions.length; index += 1) {
    if (sortedAppliedVersions[index] !== migrations[index]?.version) {
      throw new PersistenceError(
        persistenceErrorCodes.MIGRATION_DRIFT,
        "Applied migration history contains a version gap.",
      );
    }
  }

  return appliedVersions;
}

function insertMigrationRecord(database: DatabaseSync, migration: RuntimeMigration, appliedAt: string): void {
  if (!isoUtcTimestampSchema.safeParse(appliedAt).success) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_FAILED,
      "Migration timestamp must be an ISO 8601 UTC instant.",
    );
  }
  database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  ).run(migration.version, migration.name, migrationChecksum(migration), appliedAt);
}

function validateMigrationStructure(database: DatabaseSync, migration: RuntimeMigration): void {
  try {
    migration.validateStructure(database);
  } catch (error) {
    if (error instanceof PersistenceError && error.code === persistenceErrorCodes.MIGRATION_DRIFT) {
      throw error;
    }
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      `Migration ${migration.name} structure validation failed.`,
    );
  }
}

function applyMigrationTransaction(
  database: DatabaseSync,
  migration: RuntimeMigration,
  appliedAt: string,
  includeSchemaTable: boolean,
): void {
  try {
    withTransaction(database, () => {
      if (includeSchemaTable) database.exec(schemaMigrationsTableSql);
      database.exec(migration.sql);
      validateMigrationStructure(database, migration);
      insertMigrationRecord(database, migration, appliedAt);
    });
  } catch (error) {
    if (error instanceof PersistenceError && error.code === persistenceErrorCodes.MIGRATION_DRIFT) throw error;
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_FAILED,
      `Migration ${migration.name} failed.`,
    );
  }
}

export function runMigrations(
  database: DatabaseSync,
  migrations: readonly RuntimeMigration[] = runtimeMigrations,
  clock: MigrationClock = () => new Date().toISOString(),
): void {
  assertMigrationRegistry(migrations);
  if (migrations.length === 0 || migrations[0].version !== 1) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Runtime migration registry must start at version 1.",
    );
  }

  const hasSchemaMigrations = tableExists(database, "schema_migrations");
  if (!hasSchemaMigrations) {
    assertNoUnmanagedBusinessTables(database);
    applyMigrationTransaction(database, migrations[0], clock(), true);
  } else {
    assertSchemaMigrationTable(database);
  }

  const appliedRows = readAppliedMigrations(database);
  if (appliedRows.length === 0 && hasSchemaMigrations) assertNoUnmanagedBusinessTables(database);
  const appliedVersions = assertAppliedMigrations(appliedRows, migrations);
  const currentVersion = appliedVersions.size > 0 ? Math.max(...appliedVersions) : 0;
  if (currentVersion > 0) {
    validateMigrationStructure(database, migrations[currentVersion - 1]);
  }

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    applyMigrationTransaction(database, migration, clock(), false);
  }

  const finalVersion = migrations[migrations.length - 1].version;
  validateMigrationStructure(database, migrations[finalVersion - 1]);
}

/**
 * Verifies a fully migrated database without creating or changing schema
 * state. This is used only for evidence views that must not mutate their
 * retained SQLite file.
 */
export function validateReadonlyRuntimeDatabase(
  database: DatabaseSync,
  migrations: readonly RuntimeMigration[] = runtimeMigrations,
): void {
  assertMigrationRegistry(migrations);
  if (migrations.length === 0 || migrations[0].version !== 1 || !tableExists(database, "schema_migrations")) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Readonly runtime database does not have the managed migration history.",
    );
  }

  assertSchemaMigrationTable(database);
  const appliedVersions = assertAppliedMigrations(readAppliedMigrations(database), migrations);
  const finalVersion = migrations[migrations.length - 1].version;
  if (appliedVersions.size !== migrations.length || !appliedVersions.has(finalVersion)) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_DRIFT,
      "Readonly runtime database is not fully migrated.",
    );
  }
  validateMigrationStructure(database, migrations[finalVersion - 1]);
}

export function getCurrentSchemaVersion(database: DatabaseSync): number {
  if (!tableExists(database, "schema_migrations")) return 0;
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
    version?: number;
  } | undefined;
  return row?.version ?? 0;
}
