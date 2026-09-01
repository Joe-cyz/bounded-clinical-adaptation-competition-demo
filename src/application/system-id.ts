import { randomUUID } from "node:crypto";

const MAX_ID_LENGTH = 200;
const MAX_PREFIX_LENGTH = 64;
const MAX_ENTROPY_LENGTH = 128;
const GROUP_SIZE = 4;
const GROUP_SEPARATOR = "z";

function normalizePrefix(kind: string): string {
  const prefix = kind
    .toLowerCase()
    .replace(/[^a-z]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_PREFIX_LENGTH);
  return prefix || "system";
}

/**
 * Formats system-controlled identifiers so entropy can never contain a long
 * uninterrupted numeric run that resembles PII. The separator is alphabetic
 * and every entropy group is at most four characters long.
 */
export function formatSystemId(kind: string, entropy: string): string {
  const prefix = normalizePrefix(kind);
  const compactEntropy = entropy.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(0, MAX_ENTROPY_LENGTH);
  const boundedEntropy = compactEntropy || "empty";
  const groups: string[] = [];
  for (let index = 0; index < boundedEntropy.length; index += GROUP_SIZE) {
    groups.push(boundedEntropy.slice(index, index + GROUP_SIZE));
  }

  return `${prefix}-${groups.join(GROUP_SEPARATOR)}`.slice(0, MAX_ID_LENGTH);
}

export function createRandomSystemId(kind: string): string {
  return formatSystemId(kind, randomUUID());
}
