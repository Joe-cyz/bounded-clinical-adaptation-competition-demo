import type { DatabaseSync } from "node:sqlite";

import {
  createSpeechAuditEventRecord,
  type SpeechAuditEvent,
  type SpeechAuditSink,
  type SpeechIdFactory,
} from "./speech-service";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { withTransaction } from "@/infrastructure/sqlite/transaction";

/**
 * PWR-05 does not add a speech-session table. When a future configured
 * provider is enabled, only the already existing append-only audit table is
 * used for safe aggregate lifecycle metadata.
 */
export function createSqliteSpeechAuditSink(
  database: DatabaseSync,
  idFactory?: SpeechIdFactory,
): SpeechAuditSink {
  const auditEvents = createAuditEventRepository(database);
  return {
    append(event: SpeechAuditEvent): void {
      withTransaction(database, () => {
        auditEvents.append(createSpeechAuditEventRecord(event, idFactory));
      });
    },
  };
}
