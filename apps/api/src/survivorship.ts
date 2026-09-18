import { createHash, randomUUID } from "node:crypto";

import {
  SURVIVORSHIP_CONTRACT_VERSION,
  SURVIVORSHIP_POLICY_SCHEMA_VERSION,
  type CandidatePair,
  type FieldConflict,
  type FieldPolicy,
  type FieldPolicyInput,
  type FieldResolution,
  type ManualMapping,
  type ResolutionPreviewItem,
  type SurvivorshipPolicy,
  type SurvivorshipPolicyInput,
} from "@samewise/contracts";

export class SurvivorshipPolicyError extends Error {}

export function isMissingForSurvivorship(value: string): boolean {
  return value.trim().length === 0;
}

function policyConfigKey(fieldPolicies: FieldPolicyInput[]): string {
  return JSON.stringify(fieldPolicies.map((policy) => ({
    semanticField: policy.semanticField,
    strategy: policy.strategy,
    ...(policy.trustedSource ? { trustedSource: policy.trustedSource } : {}),
    ...(policy.timestampMappingId ? { timestampMappingId: policy.timestampMappingId } : {}),
  })));
}

export function buildSurvivorshipPolicy(
  input: SurvivorshipPolicyInput,
  mappings: ManualMapping[],
  configuredAt = new Date().toISOString(),
): SurvivorshipPolicy {
  const comparisonById = new Map(mappings.filter((mapping) => mapping.includeInMerge).map((mapping) => [mapping.mappingId, mapping]));
  const mappedById = new Map(mappings.map((mapping) => [mapping.mappingId, mapping]));
  const seen = new Set<string>();
  for (const fieldPolicy of input.fieldPolicies) {
    if (!comparisonById.has(fieldPolicy.semanticField)) {
      throw new SurvivorshipPolicyError(`Policy field ${fieldPolicy.semanticField} is not a mapped comparison field.`);
    }
    if (seen.has(fieldPolicy.semanticField)) {
      throw new SurvivorshipPolicyError(`Policy field ${fieldPolicy.semanticField} is duplicated.`);
    }
    seen.add(fieldPolicy.semanticField);
    if (fieldPolicy.strategy === "prefer_trusted_source") {
      if (!fieldPolicy.trustedSource || fieldPolicy.timestampMappingId) {
        throw new SurvivorshipPolicyError("Prefer trusted source requires exactly one trusted source and no timestamp mapping.");
      }
    } else if (fieldPolicy.strategy === "prefer_newest") {
      const timestampMapping = fieldPolicy.timestampMappingId ? mappedById.get(fieldPolicy.timestampMappingId) : undefined;
      if (!timestampMapping || timestampMapping.normalizer !== "date" || fieldPolicy.trustedSource) {
        throw new SurvivorshipPolicyError("Prefer newest requires a valid mapped date field and no trusted source.");
      }
    } else if (fieldPolicy.trustedSource || fieldPolicy.timestampMappingId) {
      throw new SurvivorshipPolicyError(`${fieldPolicy.strategy} does not accept trusted-source or timestamp options.`);
    }
  }
  const digest = createHash("sha256").update(policyConfigKey(input.fieldPolicies)).digest("hex").slice(0, 16);
  return {
    contractVersion: SURVIVORSHIP_CONTRACT_VERSION,
    schemaVersion: SURVIVORSHIP_POLICY_SCHEMA_VERSION,
    policyVersion: `${SURVIVORSHIP_POLICY_SCHEMA_VERSION}-${digest}`,
    fieldPolicies: input.fieldPolicies.map((policy, index) => ({ ...policy, ruleId: `rule-${index + 1}-${policy.semanticField}` })),
    configuredAt,
  };
}

function parseTrustedTimestamp(value: string): { kind: "missing" | "malformed" | "valid"; milliseconds?: number } {
  if (isMissingForSurvivorship(value)) return { kind: "missing" };
  const iso = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2}))?$/;
  if (!iso.test(value)) return { kind: "malformed" };
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return { kind: "malformed" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    return { kind: "malformed" };
  }
  return { kind: "valid", milliseconds };
}

function result(
  conflict: FieldConflict,
  outcome: ResolutionPreviewItem["outcome"],
  reasonCode: string,
  reason: string,
  extra: Partial<ResolutionPreviewItem> = {},
): ResolutionPreviewItem {
  return {
    conflictId: conflict.conflictId,
    candidateId: conflict.candidateId,
    semanticField: conflict.mappingId,
    outcome,
    chosenSource: null,
    chosenValue: null,
    keptValues: [],
    aTimestamp: null,
    bTimestamp: null,
    reasonCode,
    reason,
    ...extra,
  };
}

export function previewRuleForConflict(
  conflict: FieldConflict,
  candidate: CandidatePair,
  rule: FieldPolicy,
  mappings: ManualMapping[],
): ResolutionPreviewItem {
  if (conflict.resolution?.resolutionSource === "manual" || (conflict.resolution?.resolutionSource === "keep_both" && conflict.resolution.policyVersion === null)) {
    return result(conflict, "skipped_manual", "manual_resolution_preserved", "Skipped because an explicit manual resolution already exists.");
  }
  if (conflict.resolution) {
    return result(conflict, "skipped_existing", "existing_resolution_preserved", "Skipped because a resolution already exists; replacement requires a separate explicit action.");
  }
  if (rule.strategy === "keep_both") {
    return result(conflict, "would_resolve", "keep_both", "Would preserve both source values without selecting a canonical winner.", {
      keptValues: [{ source: "A", value: conflict.aValue }, { source: "B", value: conflict.bValue }],
    });
  }
  if (rule.strategy === "prefer_non_null") {
    const missingA = isMissingForSurvivorship(conflict.aValue);
    const missingB = isMissingForSurvivorship(conflict.bValue);
    if (missingA === missingB) {
      const reasonCode = missingA ? "both_values_missing" : "both_values_populated";
      const reason = missingA
        ? "Cannot resolve because both values are missing under the conservative empty/whitespace rule."
        : "Cannot resolve because both values are populated and disagree.";
      return result(conflict, "unresolved", reasonCode, reason);
    }
    const chosenSource = missingA ? "B" as const : "A" as const;
    return result(conflict, "would_resolve", `non_null_${chosenSource.toLowerCase()}`, `Would choose Dataset ${chosenSource} because it is the only source with a non-missing value.`, {
      chosenSource,
      chosenValue: chosenSource === "A" ? conflict.aValue : conflict.bValue,
    });
  }
  if (rule.strategy === "prefer_trusted_source") {
    const chosenSource = rule.trustedSource!;
    const chosenValue = chosenSource === "A" ? conflict.aValue : conflict.bValue;
    if (isMissingForSurvivorship(chosenValue)) {
      return result(conflict, "unresolved", "trusted_source_missing", `Cannot resolve because trusted Dataset ${chosenSource} is missing; this rule has no implicit fallback.`);
    }
    return result(conflict, "would_resolve", `trusted_source_${chosenSource.toLowerCase()}`, `Would choose Dataset ${chosenSource}, the explicitly trusted source for this field.`, { chosenSource, chosenValue });
  }

  const timestampMapping = mappings.find((mapping) => mapping.mappingId === rule.timestampMappingId)!;
  const aTimestamp = candidate.aRecord[timestampMapping.aColumn] ?? "";
  const bTimestamp = candidate.bRecord[timestampMapping.bColumn] ?? "";
  const parsedA = parseTrustedTimestamp(aTimestamp);
  const parsedB = parseTrustedTimestamp(bTimestamp);
  const timestampExtra = { aTimestamp, bTimestamp };
  if (parsedA.kind !== "valid" || parsedB.kind !== "valid") {
    const reasonCode = parsedA.kind === "missing" && parsedB.kind === "missing"
      ? "both_timestamps_missing"
      : parsedA.kind === "malformed" || parsedB.kind === "malformed"
        ? "timestamp_unparseable"
        : "timestamp_missing";
    return result(conflict, "unresolved", reasonCode, "Cannot resolve because both configured timestamps must be present and valid ISO dates or timestamps.", timestampExtra);
  }
  if (parsedA.milliseconds === parsedB.milliseconds) {
    return result(conflict, "unresolved", "timestamps_equal", "Cannot resolve because the configured timestamps represent the same instant.", timestampExtra);
  }
  const chosenSource = parsedA.milliseconds! > parsedB.milliseconds! ? "A" as const : "B" as const;
  return result(conflict, "would_resolve", `newest_${chosenSource.toLowerCase()}`, `Would choose Dataset ${chosenSource} because its configured timestamp is newer.`, {
    ...timestampExtra,
    chosenSource,
    chosenValue: chosenSource === "A" ? conflict.aValue : conflict.bValue,
  });
}

export function resolutionFromPreview(
  preview: ResolutionPreviewItem,
  conflict: FieldConflict,
  rule: FieldPolicy,
  policyVersion: string,
  resolvedAt = new Date().toISOString(),
): FieldResolution {
  if (preview.outcome !== "would_resolve") throw new Error("Only a resolvable preview can create a resolution.");
  return {
    resolutionId: `resolution-${randomUUID()}`,
    strategy: rule.strategy,
    resolutionSource: rule.strategy === "keep_both" ? "keep_both" : "rule",
    chosenSource: preview.chosenSource,
    chosenValue: preview.chosenValue,
    keptValues: preview.keptValues,
    reasonCode: preview.reasonCode,
    reason: preview.reason.replace(/^Would /, ""),
    policyVersion,
    ruleId: rule.ruleId,
    inputSnapshot: { aValue: conflict.aValue, bValue: conflict.bValue, aTimestamp: preview.aTimestamp, bTimestamp: preview.bTimestamp },
    resolvedAt,
  };
}

export function manualResolution(
  conflict: FieldConflict,
  action: "use_a" | "use_b" | "keep_both",
  resolvedAt = new Date().toISOString(),
): FieldResolution {
  const chosenSource = action === "use_a" ? "A" as const : action === "use_b" ? "B" as const : null;
  return {
    resolutionId: `resolution-${randomUUID()}`,
    strategy: action,
    resolutionSource: action === "keep_both" ? "keep_both" : "manual",
    chosenSource,
    chosenValue: chosenSource === "A" ? conflict.aValue : chosenSource === "B" ? conflict.bValue : null,
    keptValues: action === "keep_both" ? [{ source: "A", value: conflict.aValue }, { source: "B", value: conflict.bValue }] : [],
    reasonCode: action,
    reason: action === "keep_both"
      ? "A user explicitly preserved both source values without selecting a canonical winner."
      : `A user explicitly selected Dataset ${chosenSource}.`,
    policyVersion: null,
    ruleId: null,
    inputSnapshot: { aValue: conflict.aValue, bValue: conflict.bValue, aTimestamp: null, bTimestamp: null },
    resolvedAt,
  };
}
