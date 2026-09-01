import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { z } from "zod";

import {
  dataCorruptionError,
  safeSchemaFieldPath,
  suspectedPiiError,
  validationError,
} from "./errors";

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
  );
}

export function stableJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) throw validationError();
  return serialized;
}

export function validateRuntimeRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(safeSchemaFieldPath(parsed.error.issues[0]?.path ?? []));
  }

  const piiMatch = scanSuspectedPii(parsed.data);
  if (piiMatch.length > 0) {
    const match = piiMatch[0];
    throw suspectedPiiError(match.fieldPath, match.ruleId);
  }

  return parsed.data;
}

export function parseStoredJson<T>(
  raw: string,
  schema: z.ZodType<T>,
  fieldPath: string,
): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw dataCorruptionError(fieldPath);
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw dataCorruptionError(fieldPath);
  return parsed.data;
}
