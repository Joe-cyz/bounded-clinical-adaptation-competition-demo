import type { DatabaseSync } from "node:sqlite";

import type {
  AuditEventRecord,
  GenerationRunRecord,
  PhysicianProfileVersionRecord,
} from "@/domain/runtime-records";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { withTransaction } from "@/infrastructure/sqlite/transaction";

export function recordGenerationRunWithAudit(
  database: DatabaseSync,
  record: GenerationRunRecord,
  auditEvent: AuditEventRecord,
): void {
  const generationRuns = createGenerationRunRepository(database);
  const auditEvents = createAuditEventRepository(database);

  withTransaction(database, () => {
    generationRuns.insert(record);
    auditEvents.append(auditEvent);
  });
}

export function appendProfileVersionWithAudit(
  database: DatabaseSync,
  record: PhysicianProfileVersionRecord,
  expectedPreviousVersion: number | undefined,
  auditEvent: AuditEventRecord,
): void {
  const profileVersions = createPhysicianProfileVersionRepository(database);
  const auditEvents = createAuditEventRepository(database);

  withTransaction(database, () => {
    profileVersions.append(record, expectedPreviousVersion);
    auditEvents.append(auditEvent);
  });
}
