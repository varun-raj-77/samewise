import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import {
  EXPORT_SNAPSHOT_VERSION,
  CONFIRMED_MAPPINGS_VERSION,
  REVIEW_SIGNATURE_VERSION,
  MATCHER_VERSION,
  RECONCILIATION_EXPORT_VERSION,
  RUN_MANIFEST_VERSION,
  SEMANTIC_MAPPING_CONTRACT_VERSION,
  SEMANTIC_MAPPING_PROMPT_VERSION,
  SEMANTIC_MAPPING_REQUEST_VERSION,
  SURVIVORSHIP_POLICY_SCHEMA_VERSION,
  TRUSTED_EXPORT_VERSION,
  WORKFLOW_CONTRACT_VERSION,
  WORKFLOW_PROJECTION_CONTRACT_VERSION,
  inferSemanticFamily,
  type CandidateEvidenceDetail,
  type BatchIdentityDecisionResponse,
  type CandidatePair,
  type CandidateSummary,
  type ConflictPage,
  type DatasetProfile,
  type DatasetSide,
  type FieldConflict,
  type IdentityDecision,
  type ManualMapping,
  type MatcherResult,
  type MappingSuggestionDecision,
  type MappingSuggestionResponse,
  type Pagination,
  type ResultItem,
  type ResultsPage,
  type ReviewFilter,
  type ReviewGroupList,
  type ReviewGroupPreview,
  type ReviewGroupSummary,
  type ReviewQueuePage,
  type ReviewQueueProjectionItem,
  type ReviewQueueItem,
  type ReviewSort,
  type ResolutionPreview,
  type RunManifest,
  type RunView,
  type RunSummary,
  type SemanticMappingProposal,
  type SurvivorshipPolicy,
  type SurvivorshipPolicyInput,
  type TrustedExportReadiness,
} from "@samewise/contracts";

import type { MatcherRunner } from "./matcher-process.js";
import {
  buildMetadataFirstInput,
  SemanticMapperError,
  validateModelOutput,
  type SemanticMapper,
} from "./semantic-mapper.js";
import {
  buildSurvivorshipPolicy,
  manualResolution,
  previewRuleForConflict,
  resolutionFromPreview,
  SurvivorshipPolicyError,
} from "./survivorship.js";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

interface DatasetArtifact {
  profile: DatasetProfile;
  path: string;
}

interface RunState {
  runId: string;
  stage: RunView["stage"];
  datasets: Partial<Record<DatasetSide, DatasetArtifact>>;
  mappings: ManualMapping[];
  result?: MatcherResult;
  decisions: Map<string, IdentityDecision>;
  conflicts: Map<string, FieldConflict>;
  deferredARowIds: Set<string>;
  undoStack: UndoEntry[];
  mappingProposal?: SemanticMappingProposal;
  survivorshipPolicy?: SurvivorshipPolicy;
  previewedRuleIds: Set<string>;
}

interface UndoEntry {
  candidateIds: string[];
  decisionIds: string[];
  createdConflictIds: string[];
  deferredARowIds: string[];
  decisionOrigin: "human_individual" | "human_batch_rule";
  reviewGroupId: string | null;
}

export class WorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
  }
}

function safeOriginalFilename(value: string): string {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* retain original */ }
  const name = basename(decoded.replaceAll("\\", "/")).trim();
  if (!name || extname(name).toLowerCase() !== ".csv") {
    throw new WorkflowError("unsupported_file_type", "Choose a file with a .csv extension.");
  }
  return name.slice(0, 200);
}

function pagination(total: number, offset: number, limit: number): Pagination {
  const returned = Math.max(0, Math.min(limit, total - offset));
  return {
    offset,
    limit,
    total,
    returned,
    nextOffset: offset + returned < total ? offset + returned : null,
    previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
  };
}

function comparisonConflicts(run: RunState, candidate: CandidatePair, decisionId: string | null, identitySource: "human" | "system_matcher"): FieldConflict[] {
  return run.mappings
    .filter((mapping) => mapping.includeInMerge)
    .filter((mapping) => candidate.aRecord[mapping.aColumn] !== candidate.bRecord[mapping.bColumn])
    .map((mapping) => ({
      conflictId: `conflict-${candidate.candidateId}-${mapping.mappingId}`,
      runId: run.runId,
      candidateId: candidate.candidateId,
      mappingId: mapping.mappingId,
      label: mapping.label,
      aColumn: mapping.aColumn,
      bColumn: mapping.bColumn,
      aValue: candidate.aRecord[mapping.aColumn] ?? "",
      bValue: candidate.bRecord[mapping.bColumn] ?? "",
      identityDecisionId: decisionId,
      identitySource,
      status: "unresolved",
      resolution: null,
      resolutionHistory: [],
    }));
}

function reviewMarginBand(margin: number): "near_tie" | "narrow" | "clear" {
  return margin < 0.04 ? "near_tie" : margin < 0.1 ? "narrow" : "clear";
}

function reviewSignature(candidate: CandidatePair, item: ReviewQueueItem): string {
  const evidence = candidate.evidence
    .map((field) => `${field.fieldKind}:${field.evidenceClass}:${field.informationClass ?? "unknown"}`)
    .sort();
  return [
    REVIEW_SIGNATURE_VERSION,
    ...evidence,
    `margin:${reviewMarginBand(item.runnerUpMargin)}`,
    `alternatives:${item.candidateCount > 1 ? "multiple" : "single"}`,
    `collision:${item.collision}`,
    `strong:${item.strongContradiction}`,
  ].join("|");
}

function reviewGroupId(signature: string): string {
  return `review-group-${createHash("sha256").update(signature).digest("hex").slice(0, 20)}`;
}

function persistentEvidence(candidate: CandidatePair, evidenceClass: "exact_agreement" | "conflict"): boolean {
  return candidate.evidence.some((field) => field.fieldKind === "persistent_identifier" && field.evidenceClass === evidenceClass);
}

function strongPositiveCount(candidate: CandidatePair): number {
  const strongFamilies = new Set(["persistent_identifier", "name_or_title", "email", "phone", "address"]);
  return candidate.evidence.filter((field) =>
    strongFamilies.has(field.fieldKind)
    && ["exact_agreement", "partial_agreement"].includes(field.evidenceClass)
    && field.positiveContribution > 0
    && field.informationClass !== "common"
  ).length;
}

function onlyLowInformationSupport(candidate: CandidatePair): boolean {
  const positives = candidate.evidence.filter((field) => field.positiveContribution > 0);
  return positives.length > 0 && positives.every((field) =>
    ["contact_person", "geography", "categorical", "source_local_identifier", "free_text", "unknown"].includes(field.fieldKind)
    || ["repeated", "common"].includes(field.informationClass ?? "unknown")
  );
}

function eligibleForBatch(candidate: CandidatePair, item: ReviewQueueItem, decision: "same_entity" | "different_entity"): boolean {
  if (item.collision || item.runnerUpMargin < 0.04) return false;
  if (decision === "same_entity") {
    return !candidate.strongContradiction && !persistentEvidence(candidate, "conflict") && strongPositiveCount(candidate) >= 2;
  }
  return item.candidateCount === 1 && !persistentEvidence(candidate, "exact_agreement") && strongPositiveCount(candidate) < 2 && onlyLowInformationSupport(candidate);
}

function summarizeReviewGroup(entries: { item: ReviewQueueItem; candidate: CandidatePair }[]): ReviewGroupSummary {
  const first = entries[0]!;
  const signature = reviewSignature(first.candidate, first.item);
  const patternMap = new Map<string, { semanticFamily: CandidatePair["evidence"][number]["fieldKind"]; evidenceClass: CandidatePair["evidence"][number]["evidenceClass"]; informationClass: "distinctive" | "repeated" | "common" | "not_applicable" | "unknown"; labels: Set<string> }>();
  for (const field of first.candidate.evidence) {
    const informationClass = field.informationClass ?? "unknown";
    const key = `${field.fieldKind}:${field.evidenceClass}:${informationClass}`;
    const existing = patternMap.get(key) ?? { semanticFamily: field.fieldKind, evidenceClass: field.evidenceClass, informationClass, labels: new Set<string>() };
    existing.labels.add(field.label);
    patternMap.set(key, existing);
  }
  const eligibleSameCount = entries.filter(({ item, candidate }) => eligibleForBatch(candidate, item, "same_entity")).length;
  const eligibleDifferentCount = entries.filter(({ item, candidate }) => eligibleForBatch(candidate, item, "different_entity")).length;
  const suggestedDecision = eligibleSameCount === entries.length
    ? "same_entity" as const
    : eligibleDifferentCount === entries.length
      ? "different_entity" as const
      : null;
  const safetyClass = first.item.collision || first.item.runnerUpMargin < 0.04
    ? "competing_candidates" as const
    : persistentEvidence(first.candidate, "conflict") || first.candidate.strongContradiction
      ? "strong_contradiction" as const
      : onlyLowInformationSupport(first.candidate)
        ? "low_information_noise" as const
        : suggestedDecision
          ? "quick_decision" as const
          : "individual_review" as const;
  return {
    groupId: reviewGroupId(signature),
    signatureVersion: REVIEW_SIGNATURE_VERSION,
    signature,
    safetyClass,
    caseCount: entries.length,
    eligibleSameCount,
    eligibleDifferentCount,
    suggestedDecision,
    pattern: [...patternMap.values()]
      .map((value) => ({ ...value, labels: [...value.labels].sort() }))
      .sort((left, right) => `${left.semanticFamily}:${left.evidenceClass}:${left.informationClass}`.localeCompare(`${right.semanticFamily}:${right.evidenceClass}:${right.informationClass}`)),
    marginBand: reviewMarginBand(first.item.runnerUpMargin),
    alternativeBand: first.item.candidateCount > 1 ? "multiple" : "single",
    collision: first.item.collision,
    strongContradiction: first.item.strongContradiction,
  };
}

export class WorkflowStore {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly dataRoot: string,
    private readonly matcher: MatcherRunner,
    private readonly semanticMapper: SemanticMapper,
  ) {}

  createRun(): RunSummary {
    const run: RunState = {
      runId: `run-${randomUUID()}`,
      stage: "upload",
      datasets: {},
      mappings: [],
      decisions: new Map(),
      conflicts: new Map(),
      deferredARowIds: new Set(),
      undoStack: [],
      previewedRuleIds: new Set(),
    };
    this.runs.set(run.runId, run);
    return this.summaryView(run);
  }

  private requireRun(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowError("run_not_found", "Run was not found.", 404);
    return run;
  }

  async upload(runId: string, side: DatasetSide, filenameHeader: string | undefined, bytes: Buffer): Promise<RunSummary> {
    const run = this.requireRun(runId);
    if (run.datasets[side]) throw new WorkflowError("source_immutable", `Dataset ${side} is already saved and cannot be replaced.`, 409);
    if (!filenameHeader) throw new WorkflowError("filename_required", "The original CSV filename is required.");
    const originalFilename = safeOriginalFilename(filenameHeader);
    if (bytes.length === 0) throw new WorkflowError("empty_file", "CSV file cannot be empty.");
    if (bytes.length > MAX_CSV_BYTES) throw new WorkflowError("file_too_large", "CSV file exceeds the 2 MiB development limit.", 413);
    const datasetId = `dataset-${randomUUID()}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const runDirectory = resolve(this.dataRoot, run.runId);
    await mkdir(runDirectory, { recursive: true });
    const path = resolve(runDirectory, `${datasetId}.csv`);
    await writeFile(path, bytes, { flag: "wx" });
    let profile: DatasetProfile;
    try {
      profile = await this.matcher.profile({ datasetId, side, originalFilename, sha256, path });
    } catch (error) {
      const message = error instanceof Error && !error.message.includes(path)
        ? error.message
        : "CSV could not be profiled safely.";
      throw new WorkflowError("csv_parse_failed", message);
    }
    run.datasets[side] = { profile, path };
    run.stage = run.datasets.A && run.datasets.B ? "profile" : "upload";
    return this.summaryView(run);
  }

  setMappings(runId: string, mappings: ManualMapping[]): RunSummary {
    const run = this.requireRun(runId);
    const a = run.datasets.A?.profile;
    const b = run.datasets.B?.profile;
    if (!a || !b) throw new WorkflowError("datasets_required", "Upload both datasets before mapping columns.");
    if (!mappings.some((mapping) => mapping.useForMatching)) {
      throw new WorkflowError("matching_mapping_required", "Choose at least one field Samewise can use to look for the same record.");
    }
    const aColumns = new Set(a.columns.map((column) => column.name));
    const bColumns = new Set(b.columns.map((column) => column.name));
    const ids = new Set<string>();
    const pairs = new Set<string>();
    const confirmedMappings = mappings.map((mapping) => ({
      ...mapping,
      semanticFamily: mapping.semanticFamily ?? inferSemanticFamily(mapping),
    }));
    for (const mapping of confirmedMappings) {
      if (!aColumns.has(mapping.aColumn) || !bColumns.has(mapping.bColumn)) {
        throw new WorkflowError("unknown_mapping_column", "Every mapping must reference an uploaded column.");
      }
      const pair = `${mapping.aColumn}\0${mapping.bColumn}`;
      if (ids.has(mapping.mappingId) || pairs.has(pair)) {
        throw new WorkflowError("duplicate_mapping", "Duplicate mapping IDs or column pairs are not allowed.");
      }
      ids.add(mapping.mappingId);
      pairs.add(pair);
    }
    run.mappings = confirmedMappings;
    delete run.result;
    run.decisions.clear();
    run.conflicts.clear();
    delete run.survivorshipPolicy;
    run.previewedRuleIds.clear();
    run.deferredARowIds.clear();
    run.undoStack.length = 0;
    run.stage = "mapping";
    return this.summaryView(run);
  }

  async generateMappingSuggestions(runId: string): Promise<MappingSuggestionResponse> {
    const run = this.requireRun(runId);
    const a = run.datasets.A?.profile;
    const b = run.datasets.B?.profile;
    if (!a || !b) throw new WorkflowError("datasets_required", "Upload both datasets before requesting mapping suggestions.");
    const input = buildMetadataFirstInput(a, b);
    try {
      const result = await this.semanticMapper.propose(input);
      const output = validateModelOutput(result.output, input);
      const proposal: SemanticMappingProposal = {
        contractVersion: SEMANTIC_MAPPING_CONTRACT_VERSION,
        proposalId: `proposal-${randomUUID()}`,
        runId,
        provenance: {
          provider: result.provider,
          model: result.model,
          promptVersion: SEMANTIC_MAPPING_PROMPT_VERSION,
          schemaVersion: SEMANTIC_MAPPING_CONTRACT_VERSION,
          requestVersion: SEMANTIC_MAPPING_REQUEST_VERSION,
          responseId: result.responseId,
        },
        suggestions: output.mappings.map((mapping) => ({
          suggestionId: `suggestion-${randomUUID()}`,
          ...mapping,
          status: "pending",
          finalMapping: null,
        })),
        unmappedLeft: output.unmappedLeft,
        unmappedRight: output.unmappedRight,
        createdAt: new Date().toISOString(),
      };
      run.mappingProposal = proposal;
      run.stage = "mapping";
      return this.mappingResponse(run);
    } catch (error) {
      if (error instanceof SemanticMapperError) {
        throw new WorkflowError(
          `ai_${error.category}`,
          "AI suggestions unavailable. You can continue mapping columns manually.",
          503,
        );
      }
      throw error;
    }
  }

  decideMappingSuggestion(
    runId: string,
    suggestionId: string,
    decision: MappingSuggestionDecision,
  ): MappingSuggestionResponse {
    const run = this.requireRun(runId);
    const suggestion = run.mappingProposal?.suggestions.find((item) => item.suggestionId === suggestionId);
    if (!suggestion || !run.mappingProposal) throw new WorkflowError("suggestion_not_found", "Mapping suggestion was not found.", 404);
    if (suggestion.status !== "pending") throw new WorkflowError("suggestion_already_decided", "This mapping suggestion already has a decision.", 409);
    if (decision.decision === "reject") {
      suggestion.status = "rejected";
      return this.mappingResponse(run);
    }

    const finalMapping = decision.decision === "remap"
      ? { ...decision.finalMapping!, semanticFamily: decision.finalMapping!.semanticFamily ?? inferSemanticFamily(decision.finalMapping!) }
      : this.mappingFromSuggestion(run, suggestion);
    this.validateConfirmedMapping(run, finalMapping);
    run.mappings.push(finalMapping);
    suggestion.status = decision.decision === "remap" ? "edited" : "accepted";
    suggestion.finalMapping = finalMapping;
    return this.mappingResponse(run);
  }

  private mappingFromSuggestion(run: RunState, suggestion: SemanticMappingProposal["suggestions"][number]): ManualMapping {
    const aType = run.datasets.A?.profile.columns.find((column) => column.name === suggestion.leftColumn)?.inferredType;
    const bType = run.datasets.B?.profile.columns.find((column) => column.name === suggestion.rightColumn)?.inferredType;
    const normalizer = suggestion.normalizationHints.includes("phone_digits")
      ? "phone"
      : aType === "date" && bType === "date"
        ? "date"
        : ["integer", "number"].includes(aType ?? "") && ["integer", "number"].includes(bType ?? "")
          ? "number"
          : suggestion.leftColumn.toLowerCase().includes("email") && suggestion.rightColumn.toLowerCase().includes("email")
            ? "email"
            : "text";
    return {
      mappingId: `mapping-${suggestion.suggestionId}`,
      label: suggestion.leftColumn.replaceAll("_", " "),
      aColumn: suggestion.leftColumn,
      bColumn: suggestion.rightColumn,
      normalizer,
      useForMatching: suggestion.useForMatching,
      includeInMerge: suggestion.includeInMerge,
      semanticFamily: suggestion.semanticFamily,
    };
  }

  private validateConfirmedMapping(run: RunState, mapping: ManualMapping): void {
    const aColumns = new Set(run.datasets.A?.profile.columns.map((column) => column.name) ?? []);
    const bColumns = new Set(run.datasets.B?.profile.columns.map((column) => column.name) ?? []);
    if (!aColumns.has(mapping.aColumn) || !bColumns.has(mapping.bColumn)) {
      throw new WorkflowError("unknown_mapping_column", "Every mapping must reference an uploaded column.");
    }
    if (run.mappings.some((item) => item.mappingId === mapping.mappingId || (item.aColumn === mapping.aColumn && item.bColumn === mapping.bColumn))) {
      throw new WorkflowError("duplicate_mapping", "Duplicate mapping IDs or column pairs are not allowed.");
    }
  }

  private mappingResponse(run: RunState): MappingSuggestionResponse {
    if (!run.mappingProposal) throw new WorkflowError("suggestions_unavailable", "No mapping proposal is available.", 404);
    return {
      contractVersion: SEMANTIC_MAPPING_CONTRACT_VERSION,
      proposal: run.mappingProposal,
      confirmedMappings: run.mappings,
    };
  }

  async match(runId: string): Promise<RunSummary> {
    const run = this.requireRun(runId);
    if (!run.datasets.A || !run.datasets.B || !run.mappings.some((mapping) => mapping.useForMatching)) {
      throw new WorkflowError("run_not_ready", "Both datasets and at least one matching field are required.");
    }
    run.result = await this.matcher.match({
      aPath: run.datasets.A.path,
      bPath: run.datasets.B.path,
      mappings: run.mappings.filter((mapping) => mapping.useForMatching),
    });
    run.decisions.clear();
    run.conflicts.clear();
    run.deferredARowIds.clear();
    run.undoStack.length = 0;
    run.previewedRuleIds.clear();
    for (const candidate of run.result.candidates.filter((item) => item.rank === 1 && item.band === "auto_match")) {
      for (const conflict of comparisonConflicts(run, candidate, null, "system_matcher")) run.conflicts.set(conflict.conflictId, conflict);
    }
    run.stage = "results";
    return this.summaryView(run);
  }

  decide(runId: string, candidateId: string, humanDecision: "same_entity" | "different_entity"): RunSummary {
    const run = this.requireRun(runId);
    if (!run.result) throw new WorkflowError("run_not_matched", "Run the matcher before recording identity decisions.", 409);
    const candidate = run.result.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new WorkflowError("candidate_not_found", "Candidate was not found.", 404);
    if (run.decisions.has(candidateId)) throw new WorkflowError("decision_exists", "This candidate already has a recorded decision.", 409);
    if (humanDecision === "different_entity" && [...run.conflicts.values()].some((conflict) => conflict.candidateId === candidateId && conflict.resolution)) {
      throw new WorkflowError("identity_change_blocked_by_resolutions", "This identity link has dependent field resolutions. Clear them before rejecting the identity.", 409);
    }
    if (humanDecision === "same_entity") {
      const existingSame = [...run.decisions.values()].some((decision) => decision.aRowId === candidate.aRowId && decision.humanDecision === "same_entity");
      if (existingSame) throw new WorkflowError("identity_already_confirmed", "This A row already has a confirmed identity.", 409);
    }
    const { decision, createdConflictIds, wasDeferred } = this.recordDecision(
      run,
      candidate,
      humanDecision,
      "human_individual",
      null,
      new Date().toISOString(),
    );
    run.undoStack.push({
      candidateIds: [candidateId],
      decisionIds: [decision.decisionId],
      createdConflictIds,
      deferredARowIds: wasDeferred ? [candidate.aRowId] : [],
      decisionOrigin: "human_individual",
      reviewGroupId: null,
    });
    if (run.undoStack.length > 20) run.undoStack.shift();
    run.previewedRuleIds.clear();
    return this.summaryView(run);
  }

  private recordDecision(
    run: RunState,
    candidate: CandidatePair,
    humanDecision: "same_entity" | "different_entity",
    decisionOrigin: "human_individual" | "human_batch_rule",
    groupId: string | null,
    decidedAt: string,
  ): { decision: IdentityDecision; createdConflictIds: string[]; wasDeferred: boolean } {
    const result = run.result;
    if (!result) throw new Error("Matcher result is unavailable for this run.");
    const decision: IdentityDecision = {
      decisionId: `decision-${randomUUID()}`,
      runId: run.runId,
      candidateId: candidate.candidateId,
      aRowId: candidate.aRowId,
      bRowId: candidate.bRowId,
      systemProposal: candidate.band,
      humanDecision,
      matcherVersion: result.matcherVersion,
      candidateEngineVersion: result.candidateEngineVersion,
      matchScore: candidate.matchScore,
      evidenceShown: candidate.evidence,
      decisionOrigin,
      reviewSignatureVersion: groupId ? REVIEW_SIGNATURE_VERSION : null,
      reviewGroupId: groupId,
      evidenceSnapshotSha256: createHash("sha256").update(JSON.stringify(candidate.evidence)).digest("hex"),
      decidedAt,
    };
    run.decisions.set(candidate.candidateId, decision);
    const createdConflictIds: string[] = [];
    if (humanDecision === "same_entity") {
      for (const conflict of comparisonConflicts(run, candidate, decision.decisionId, "human")) {
        if (!run.conflicts.has(conflict.conflictId)) createdConflictIds.push(conflict.conflictId);
        const existing = run.conflicts.get(conflict.conflictId);
        if (existing) {
          existing.identityDecisionId = decision.decisionId;
          existing.identitySource = "human";
        } else {
          run.conflicts.set(conflict.conflictId, conflict);
        }
      }
      run.stage = run.conflicts.size ? "resolution" : "review";
    } else {
      run.stage = "review";
    }
    const wasDeferred = run.deferredARowIds.delete(candidate.aRowId);
    return { decision, createdConflictIds, wasDeferred };
  }

  setDeferred(runId: string, aRowId: string, deferred: boolean): RunSummary {
    const run = this.requireRun(runId);
    const candidates = run.result?.candidates.filter((candidate) => candidate.aRowId === aRowId) ?? [];
    if (!candidates.length) throw new WorkflowError("review_item_not_found", "Review item was not found.", 404);
    const hasSame = [...run.decisions.values()].some((decision) => decision.aRowId === aRowId && decision.humanDecision === "same_entity");
    const hasUnresolved = candidates.some((candidate) => !run.decisions.has(candidate.candidateId));
    if (hasSame || !hasUnresolved) throw new WorkflowError("review_item_resolved", "Only an unresolved review item can be deferred.", 409);
    if (deferred) run.deferredARowIds.add(aRowId);
    else run.deferredARowIds.delete(aRowId);
    run.stage = "review";
    run.previewedRuleIds.clear();
    return this.summaryView(run);
  }

  undo(runId: string): RunSummary {
    const run = this.requireRun(runId);
    const entry = run.undoStack.at(-1);
    if (!entry) throw new WorkflowError("nothing_to_undo", "There is no recent review decision to undo.", 409);
    const decisions = entry.candidateIds.map((candidateId) => run.decisions.get(candidateId));
    if (decisions.some((decision, index) => !decision || decision.decisionId !== entry.decisionIds[index])) {
      throw new WorkflowError("undo_state_changed", "The recent decision can no longer be undone safely.", 409);
    }
    const hasDependentResolution = entry.createdConflictIds.some((conflictId) => run.conflicts.get(conflictId)?.resolution);
    if (hasDependentResolution) {
      throw new WorkflowError(
        "undo_blocked_by_resolutions",
        "Undo is blocked because a field conflict created by this SAME decision has already been resolved. Revert that field resolution first.",
        409,
      );
    }
    for (const candidateId of entry.candidateIds) run.decisions.delete(candidateId);
    for (const conflictId of entry.createdConflictIds) run.conflicts.delete(conflictId);
    for (const aRowId of entry.deferredARowIds) run.deferredARowIds.add(aRowId);
    run.undoStack.pop();
    run.stage = "review";
    run.previewedRuleIds.clear();
    return this.summaryView(run);
  }

  resolveConflict(runId: string, conflictId: string, action: "use_a" | "use_b" | "keep_both", replace = false): RunSummary {
    const run = this.requireRun(runId);
    const conflict = run.conflicts.get(conflictId);
    if (!conflict) throw new WorkflowError("conflict_not_found", "Field conflict was not found.", 404);
    if (!this.effectiveLinks(run).some((candidate) => candidate.candidateId === conflict.candidateId)) {
      throw new WorkflowError("identity_not_confirmed", "Field resolution requires an effective confirmed identity link.", 409);
    }
    if (conflict.resolution && !replace) throw new WorkflowError("resolution_exists", "This conflict is already resolved. Explicitly replace or clear it first.", 409);
    if (conflict.resolution) conflict.resolutionHistory.push(conflict.resolution);
    conflict.resolution = manualResolution(conflict, action);
    conflict.status = "resolved";
    run.stage = "resolution";
    run.previewedRuleIds.clear();
    return this.summaryView(run);
  }

  clearResolution(runId: string, conflictId: string): RunSummary {
    const run = this.requireRun(runId);
    const conflict = run.conflicts.get(conflictId);
    if (!conflict) throw new WorkflowError("conflict_not_found", "Field conflict was not found.", 404);
    if (!conflict.resolution) throw new WorkflowError("resolution_missing", "This conflict is already unresolved.", 409);
    conflict.resolutionHistory.push(conflict.resolution);
    conflict.resolution = null;
    conflict.status = "unresolved";
    run.stage = "resolution";
    run.previewedRuleIds.clear();
    return this.summaryView(run);
  }

  setSurvivorshipPolicy(runId: string, input: SurvivorshipPolicyInput): RunSummary {
    const run = this.requireRun(runId);
    if (!run.result) throw new WorkflowError("run_not_matched", "Run the matcher before configuring survivorship.");
    try {
      const policy = buildSurvivorshipPolicy(input, run.mappings);
      run.survivorshipPolicy = policy;
      run.previewedRuleIds.clear();
    } catch (error) {
      if (error instanceof SurvivorshipPolicyError) throw new WorkflowError("invalid_survivorship_policy", error.message);
      throw error;
    }
    run.stage = "resolution";
    return this.summaryView(run);
  }

  previewSurvivorshipRule(runId: string, ruleId: string): ResolutionPreview {
    const run = this.requireRun(runId);
    const policy = run.survivorshipPolicy;
    const rule = policy?.fieldPolicies.find((item) => item.ruleId === ruleId);
    if (!policy || !rule) throw new WorkflowError("survivorship_rule_not_found", "Configured survivorship rule was not found.", 404);
    const effectiveCandidateIds = new Set(this.effectiveLinks(run).map((candidate) => candidate.candidateId));
    const items = [...run.conflicts.values()]
      .filter((conflict) => conflict.mappingId === rule.semanticField && effectiveCandidateIds.has(conflict.candidateId))
      .sort((left, right) => left.conflictId.localeCompare(right.conflictId))
      .map((conflict) => {
        const candidate = run.result!.candidates.find((item) => item.candidateId === conflict.candidateId)!;
        return previewRuleForConflict(conflict, candidate, rule, run.mappings);
      });
    const preview: ResolutionPreview = {
      contractVersion: "1.0.0",
      runId,
      policyVersion: policy.policyVersion,
      ruleId,
      semanticField: rule.semanticField,
      strategy: rule.strategy,
      affectedCount: items.length,
      resolvableCount: items.filter((item) => item.outcome === "would_resolve").length,
      unresolvedCount: items.filter((item) => item.outcome === "unresolved").length,
      skippedManualCount: items.filter((item) => item.outcome === "skipped_manual").length,
      items,
    };
    run.previewedRuleIds.add(ruleId);
    return preview;
  }

  applySurvivorshipRule(runId: string, ruleId: string): { run: RunSummary; policyVersion: string; ruleId: string; appliedCount: number; unresolvedCount: number; skippedCount: number } {
    const run = this.requireRun(runId);
    const policy = run.survivorshipPolicy;
    const rule = policy?.fieldPolicies.find((item) => item.ruleId === ruleId);
    if (!policy || !rule) throw new WorkflowError("survivorship_rule_not_found", "Configured survivorship rule was not found.", 404);
    if (!run.previewedRuleIds.has(ruleId)) throw new WorkflowError("survivorship_preview_required", "Preview this rule against the current conflict state before applying it.", 409);
    const preview = this.previewSurvivorshipRule(runId, ruleId);
    const mutations = preview.items.filter((item) => item.outcome === "would_resolve").map((item) => {
      const conflict = run.conflicts.get(item.conflictId)!;
      return { conflict, resolution: resolutionFromPreview(item, conflict, rule, policy.policyVersion) };
    });
    for (const mutation of mutations) {
      mutation.conflict.resolution = mutation.resolution;
      mutation.conflict.status = "resolved";
    }
    run.stage = "resolution";
    run.previewedRuleIds.clear();
    return {
      run: this.summaryView(run),
      policyVersion: policy.policyVersion,
      ruleId,
      appliedCount: mutations.length,
      unresolvedCount: preview.unresolvedCount,
      skippedCount: preview.items.length - mutations.length - preview.unresolvedCount,
    };
  }

  get(runId: string): RunSummary { return this.summaryView(this.requireRun(runId)); }

  evaluationView(runId: string): RunView { return this.view(this.requireRun(runId)); }

  resultsPage(runId: string, offset: number, limit: number): ResultsPage {
    const run = this.requireRun(runId);
    const result = run.result;
    if (!result) return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      items: [],
      page: pagination(0, offset, limit),
      ordering: "a_row_id_ascending",
    };
    const groups = new Map<string, CandidatePair[]>();
    for (const candidate of result.candidates) {
      const group = groups.get(candidate.aRowId) ?? [];
      group.push(candidate);
      groups.set(candidate.aRowId, group);
    }
    const queueByA = new Map(this.reviewQueue(run, result.candidates).map((item) => [item.aRowId, item]));
    const items: Omit<ResultItem, "sourceOrder">[] = [...groups.entries()].map(([aRowId, unsorted]) => {
      const options = [...unsorted].sort((left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId));
      const queueItem = queueByA.get(aRowId);
      const top = queueItem
        ? options.find((candidate) => candidate.candidateId === queueItem.topCandidateId) ?? options[0]!
        : options[0]!;
      const status = queueItem?.state === "reviewed_same"
        ? "reviewed_same" as const
        : queueItem?.state === "reviewed_different"
          ? "reviewed_different" as const
          : queueItem
            ? "needs_review" as const
            : "auto_match" as const;
      return {
        aRowId,
        aIdentity: this.identityRecord(run, top, "A"),
        status,
        topCandidate: this.candidateSummary(run, top),
        topBIdentity: this.identityRecord(run, top, "B"),
        alternativeCount: Math.max(0, options.length - 1),
        collision: top.collision || (queueItem?.collision ?? false),
      };
    });
    for (const row of result.onlyA) {
      items.push({
        aRowId: row.rowId,
        aIdentity: Object.fromEntries(run.mappings.filter((mapping) => mapping.useForMatching).map((mapping) => [mapping.aColumn, row.record[mapping.aColumn] ?? ""])),
        status: "unmatched",
        topCandidate: null,
        topBIdentity: null,
        alternativeCount: 0,
        collision: false,
      });
    }
    items.sort((left, right) => left.aRowId.localeCompare(right.aRowId));
    const projected = items.map((item, sourceOrder) => ({ ...item, sourceOrder }));
    return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      items: projected.slice(offset, offset + limit),
      page: pagination(projected.length, offset, limit),
      ordering: "a_row_id_ascending",
    };
  }

  reviewPage(
    runId: string,
    offset: number,
    limit: number,
    filter: ReviewFilter,
    sort: ReviewSort,
    query: string,
  ): ReviewQueuePage {
    const run = this.requireRun(runId);
    const candidates = run.result?.candidates ?? [];
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const all = this.reviewQueue(run, candidates);
    const filtered = all.filter((item) => {
      if (filter === "unresolved" && item.state !== "needs_review") return false;
      if (filter === "deferred" && item.state !== "deferred") return false;
      if (filter === "collision" && !item.collision) return false;
      if (filter === "contradiction" && !item.strongContradiction && !item.strongestContradiction) return false;
      if (filter === "multiple" && item.candidateCount <= 1) return false;
      if (!normalizedQuery) return true;
      const top = candidateById.get(item.topCandidateId);
      const name = top?.evidence.find((evidence) => evidence.fieldKind === "name");
      return [item.aRowId, item.topBRowId, name?.aValue, name?.bValue]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
    filtered.sort((left, right) => {
      if (sort === "ambiguity") return left.runnerUpMargin - right.runnerUpMargin || right.topMatchScore - left.topMatchScore || left.sourceOrder - right.sourceOrder;
      if (sort === "score_desc") return right.topMatchScore - left.topMatchScore || left.sourceOrder - right.sourceOrder;
      if (sort === "score_asc") return left.topMatchScore - right.topMatchScore || left.sourceOrder - right.sourceOrder;
      if (sort === "candidate_count") return right.candidateCount - left.candidateCount || left.sourceOrder - right.sourceOrder;
      return left.sourceOrder - right.sourceOrder;
    });
    const projected = filtered.slice(offset, offset + limit).map((item) => this.reviewProjection(run, item, candidateById));
    const reviewed = all.filter((item) => item.state === "reviewed_same" || item.state === "reviewed_different").length;
    const deferred = all.filter((item) => item.state === "deferred").length;
    const remaining = all.filter((item) => item.state === "needs_review").length;
    return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      items: projected,
      page: pagination(filtered.length, offset, limit),
      progress: { total: all.length, reviewed, remaining, deferred },
      filter,
      sort,
      query,
    };
  }

  private unresolvedReviewGroups(run: RunState): Map<string, { item: ReviewQueueItem; candidate: CandidatePair }[]> {
    const candidates = run.result?.candidates ?? [];
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const groups = new Map<string, { item: ReviewQueueItem; candidate: CandidatePair }[]>();
    for (const item of this.reviewQueue(run, candidates).filter((entry) => entry.state === "needs_review")) {
      const candidate = candidateById.get(item.topCandidateId);
      if (!candidate) continue;
      const signature = reviewSignature(candidate, item);
      const entries = groups.get(signature) ?? [];
      entries.push({ item, candidate });
      groups.set(signature, entries);
    }
    return groups;
  }

  reviewGroups(runId: string): ReviewGroupList {
    const run = this.requireRun(runId);
    const summaries = [...this.unresolvedReviewGroups(run).values()]
      .map(summarizeReviewGroup)
      .sort((left, right) => {
        const order = ["quick_decision", "competing_candidates", "strong_contradiction", "low_information_noise", "individual_review"];
        return order.indexOf(left.safetyClass) - order.indexOf(right.safetyClass)
          || right.caseCount - left.caseCount
          || left.groupId.localeCompare(right.groupId);
      });
    const count = (safetyClass: ReviewGroupSummary["safetyClass"]) => summaries
      .filter((group) => group.safetyClass === safetyClass)
      .reduce((total, group) => total + group.caseCount, 0);
    const deferred = this.reviewQueue(run, run.result?.candidates ?? []).filter((item) => item.state === "deferred").length;
    const workload = {
      signatureVersion: REVIEW_SIGNATURE_VERSION,
      totalNeedsAttention: summaries.reduce((total, group) => total + group.caseCount, 0),
      quickDecisions: count("quick_decision"),
      competingCandidates: count("competing_candidates"),
      strongContradictions: count("strong_contradiction"),
      lowInformationNoise: count("low_information_noise"),
      individualReview: count("individual_review"),
      deferred,
      groupCount: summaries.length,
    };
    return { contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION, runId, workload, groups: summaries };
  }

  reviewGroupPreview(runId: string, groupId: string, offset: number, limit: number): ReviewGroupPreview {
    const run = this.requireRun(runId);
    const entries = [...this.unresolvedReviewGroups(run).values()].find((values) => summarizeReviewGroup(values).groupId === groupId);
    if (!entries) throw new WorkflowError("review_group_not_found", "Review group was not found or no longer needs attention.", 404);
    const group = summarizeReviewGroup(entries);
    const candidateById = new Map((run.result?.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]));
    const ordered = [...entries].sort((left, right) => left.item.sourceOrder - right.item.sourceOrder || left.item.aRowId.localeCompare(right.item.aRowId));
    return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      group,
      items: ordered.slice(offset, offset + limit).map(({ item }) => this.reviewProjection(run, item, candidateById)),
      page: pagination(ordered.length, offset, limit),
    };
  }

  batchDecide(runId: string, groupId: string, humanDecision: "same_entity" | "different_entity"): BatchIdentityDecisionResponse {
    const run = this.requireRun(runId);
    if (!run.result) throw new WorkflowError("run_not_matched", "Run the matcher before recording identity decisions.", 409);
    const entries = [...this.unresolvedReviewGroups(run).values()].find((values) => summarizeReviewGroup(values).groupId === groupId);
    if (!entries) throw new WorkflowError("review_group_not_found", "Review group was not found or no longer needs attention.", 404);
    const group = summarizeReviewGroup(entries);
    const eligible = entries.filter(({ item, candidate }) => eligibleForBatch(candidate, item, humanDecision));
    if (!eligible.length) throw new WorkflowError("batch_decision_not_safe", "No cases in this group are eligible for that batch decision.", 409);
    const decidedAt = new Date().toISOString();
    const candidateIds: string[] = [];
    const decisionIds: string[] = [];
    const createdConflictIds: string[] = [];
    const deferredARowIds: string[] = [];
    for (const { candidate } of eligible) {
      const recorded = this.recordDecision(run, candidate, humanDecision, "human_batch_rule", groupId, decidedAt);
      candidateIds.push(candidate.candidateId);
      decisionIds.push(recorded.decision.decisionId);
      createdConflictIds.push(...recorded.createdConflictIds);
      if (recorded.wasDeferred) deferredARowIds.push(candidate.aRowId);
    }
    run.undoStack.push({ candidateIds, decisionIds, createdConflictIds, deferredARowIds, decisionOrigin: "human_batch_rule", reviewGroupId: groupId });
    if (run.undoStack.length > 20) run.undoStack.shift();
    run.previewedRuleIds.clear();
    return {
      run: this.summaryView(run),
      groupId,
      signatureVersion: REVIEW_SIGNATURE_VERSION,
      decision: humanDecision,
      appliedCount: eligible.length,
      excludedCount: group.caseCount - eligible.length,
    };
  }

  candidateDetail(runId: string, candidateId: string): CandidateEvidenceDetail {
    const run = this.requireRun(runId);
    const candidates = run.result?.candidates ?? [];
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new WorkflowError("candidate_not_found", "Candidate was not found in this run.", 404);
    const queueItem = this.reviewQueue(run, candidates).find((item) => item.aRowId === candidate.aRowId);
    const collisionARowIds = [...new Set(candidates
      .filter((item) => item.bRowId === candidate.bRowId && item.aRowId !== candidate.aRowId)
      .map((item) => item.aRowId))].sort();
    const effectiveCollisionARowIds = [...new Set(this.effectiveLinks(run)
      .filter((item) => item.bRowId === candidate.bRowId && item.aRowId !== candidate.aRowId)
      .map((item) => item.aRowId))].sort();
    return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      candidate,
      alternatives: candidates
        .filter((item) => item.aRowId === candidate.aRowId)
        .sort((left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId))
        .map((item) => this.candidateSummary(run, item)),
      reviewState: queueItem?.state ?? "auto_match",
      deferred: queueItem?.deferred ?? false,
      collisionARowIds,
      effectiveCollisionARowIds,
      humanDecision: run.decisions.get(candidateId) ?? null,
      conflicts: [...run.conflicts.values()].filter((conflict) => conflict.candidateId === candidateId),
      matcherVersion: run.result!.matcherVersion,
      candidateEngineVersion: run.result!.candidateEngineVersion,
    };
  }

  conflictPage(runId: string, offset: number, limit: number): ConflictPage {
    const run = this.requireRun(runId);
    const candidateById = new Map((run.result?.candidates ?? []).map((candidate) => [candidate.candidateId, candidate]));
    const effectiveCandidateIds = new Set(this.effectiveLinks(run).map((candidate) => candidate.candidateId));
    const items = [...run.conflicts.values()]
      .filter((conflict) => effectiveCandidateIds.has(conflict.candidateId))
      .sort((left, right) => left.conflictId.localeCompare(right.conflictId))
      .map((conflict) => {
        const candidate = candidateById.get(conflict.candidateId)!;
        return { ...conflict, aRowId: candidate.aRowId, bRowId: candidate.bRowId };
      });
    return {
      contractVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId,
      items: items.slice(offset, offset + limit),
      page: pagination(items.length, offset, limit),
      ordering: "conflict_id_ascending",
    };
  }

  exportSnapshot(runId: string): RunExportSnapshot {
    const run = this.requireRun(runId);
    return buildExportSnapshot(this.view(run), run.mappingProposal);
  }

  private effectiveLinks(run: RunState): CandidatePair[] {
    const candidates = run.result?.candidates ?? [];
    const humanSameByA = new Map(
      [...run.decisions.values()].filter((decision) => decision.humanDecision === "same_entity").map((decision) => [decision.aRowId, decision]),
    );
    const rejectedCandidates = new Set(
      [...run.decisions.values()].filter((decision) => decision.humanDecision === "different_entity").map((decision) => decision.candidateId),
    );
    return [
      ...candidates.filter((candidate) => humanSameByA.get(candidate.aRowId)?.candidateId === candidate.candidateId),
      ...candidates.filter((candidate) => candidate.rank === 1 && candidate.band === "auto_match" && !humanSameByA.has(candidate.aRowId) && !rejectedCandidates.has(candidate.candidateId)),
    ];
  }

  private identityRecord(run: RunState, candidate: CandidatePair, side: DatasetSide): Record<string, string> {
    return Object.fromEntries(run.mappings
      .filter((mapping) => mapping.useForMatching)
      .map((mapping) => {
        const column = side === "A" ? mapping.aColumn : mapping.bColumn;
        const record = side === "A" ? candidate.aRecord : candidate.bRecord;
        return [column, record[column] ?? ""];
      }));
  }

  private candidateSummary(run: RunState, candidate: CandidatePair): CandidateSummary {
    const strongestPositive = [...candidate.evidence]
      .filter((evidence) => evidence.positiveContribution > 0)
      .sort((left, right) => right.positiveContribution - left.positiveContribution)[0] ?? null;
    const strongestContradiction = [...candidate.evidence]
      .filter((evidence) => evidence.conflictContribution > 0)
      .sort((left, right) => right.conflictContribution - left.conflictContribution)[0] ?? null;
    const decision = run.decisions.get(candidate.candidateId);
    return {
      candidateId: candidate.candidateId,
      bRowId: candidate.bRowId,
      rank: candidate.rank,
      matchScore: candidate.matchScore,
      band: candidate.band,
      collision: candidate.collision,
      strongContradiction: candidate.strongContradiction,
      strongestPositive: strongestPositive ? {
        mappingId: strongestPositive.mappingId,
        label: strongestPositive.label,
        evidenceClass: strongestPositive.evidenceClass,
        contribution: strongestPositive.contribution,
      } : null,
      strongestContradiction: strongestContradiction ? {
        mappingId: strongestContradiction.mappingId,
        label: strongestContradiction.label,
        evidenceClass: strongestContradiction.evidenceClass,
        contribution: strongestContradiction.contribution,
      } : null,
      humanDecision: decision ? {
        candidateId: decision.candidateId,
        aRowId: decision.aRowId,
        bRowId: decision.bRowId,
        humanDecision: decision.humanDecision,
        decidedAt: decision.decidedAt,
      } : null,
    };
  }

  private reviewProjection(
    run: RunState,
    item: ReviewQueueItem,
    candidateById: Map<string, CandidatePair>,
  ): ReviewQueueProjectionItem {
    const candidates = item.candidateIds
      .map((candidateId) => candidateById.get(candidateId))
      .filter((candidate): candidate is CandidatePair => Boolean(candidate))
      .sort((left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId));
    const top = candidateById.get(item.topCandidateId)!;
    return {
      aRowId: item.aRowId,
      topCandidateId: item.topCandidateId,
      topBRowId: item.topBRowId,
      topMatchScore: item.topMatchScore,
      runnerUpMargin: item.runnerUpMargin,
      candidateCount: item.candidateCount,
      strongestPositive: item.strongestPositive,
      strongestContradiction: item.strongestContradiction,
      collision: item.collision,
      collisionARowIds: item.collisionARowIds,
      strongContradiction: item.strongContradiction,
      state: item.state,
      deferred: item.deferred,
      humanDecision: item.humanDecision,
      matcherVersion: item.matcherVersion,
      sourceOrder: item.sourceOrder,
      aIdentity: this.identityRecord(run, top, "A"),
      topBIdentity: this.identityRecord(run, top, "B"),
      candidates: candidates.map((candidate) => this.candidateSummary(run, candidate)),
    };
  }

  private summaryView(run: RunState): RunSummary {
    const view = this.view(run);
    const resolved = view.conflicts.filter((conflict) => conflict.resolution !== null).length;
    const manualDecisions = view.conflicts.filter((conflict) =>
      conflict.resolution !== null && conflict.resolution.policyVersion === null,
    ).length;
    const preservedBoth = view.conflicts.filter((conflict) =>
      conflict.resolution?.strategy === "keep_both",
    ).length;
    const fields = view.mappings.filter((mapping) => mapping.includeInMerge).slice(0, 200).map((mapping) => {
      const conflicts = view.conflicts.filter((conflict) => conflict.mappingId === mapping.mappingId);
      const fieldResolved = conflicts.filter((conflict) => conflict.resolution !== null).length;
      const policy = view.survivorshipPolicy?.fieldPolicies.find((item) => item.semanticField === mapping.mappingId);
      return {
        mappingId: mapping.mappingId,
        label: mapping.label,
        total: conflicts.length,
        resolved: fieldResolved,
        unresolved: conflicts.length - fieldResolved,
        currentPolicy: policy?.strategy ?? null,
      };
    });
    return {
      contractVersion: view.contractVersion,
      projectionVersion: WORKFLOW_PROJECTION_CONTRACT_VERSION,
      runId: view.runId,
      stage: view.stage,
      datasets: view.datasets,
      mappings: view.mappings,
      mappingVersion: view.mappingVersion,
      semanticMappingProvenance: view.semanticMappingProvenance,
      matcherVersion: view.matcherVersion,
      matcherProvenance: view.matcherProvenance,
      summary: view.summary,
      survivorshipPolicy: view.survivorshipPolicy,
      trustedExportReadiness: view.trustedExportReadiness,
      reviewProgress: view.reviewProgress,
      reviewUndo: view.reviewUndo,
      conflictSummary: {
        total: view.conflicts.length,
        resolved,
        unresolved: view.conflicts.length - resolved,
        manualDecisions,
        preservedBoth,
        fields,
      },
    };
  }

  private view(run: RunState): RunView {
    const result = run.result;
    const candidates = result?.candidates ?? [];
    const effectiveLinks = this.effectiveLinks(run);
    const matchedA = new Set<string>();
    const matchedB = new Set<string>();
    for (const candidate of effectiveLinks) {
      matchedA.add(candidate.aRowId); matchedB.add(candidate.bRowId);
    }
    const reviewQueue = this.reviewQueue(run, candidates);
    const unresolvedReview = reviewQueue.filter((item) => item.state === "needs_review" || item.state === "deferred");
    const reviewA = new Set(unresolvedReview.map((item) => item.aRowId));
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const reviewB = new Set<string>();
    for (const item of unresolvedReview) {
      for (const candidateId of item.candidateIds) {
        if (run.decisions.has(candidateId)) continue;
        const candidate = candidateById.get(candidateId);
        if (candidate && !matchedB.has(candidate.bRowId)) reviewB.add(candidate.bRowId);
      }
    }
    const differentA = new Set(
      [...run.decisions.values()]
        .filter((decision) => decision.humanDecision === "different_entity" && !reviewA.has(decision.aRowId) && !matchedA.has(decision.aRowId))
        .map((decision) => decision.aRowId),
    );
    const onlyA = [...(result?.onlyA ?? [])];
    for (const rowId of differentA) {
      const candidate = candidates.find((item) => item.aRowId === rowId);
      if (candidate && !onlyA.some((row) => row.rowId === rowId)) onlyA.push({ rowId, record: candidate.aRecord });
    }
    const onlyBById = new Map((result?.onlyB ?? []).map((row) => [row.rowId, row]));
    for (const candidate of candidates) {
      if (!matchedB.has(candidate.bRowId)) {
        onlyBById.set(candidate.bRowId, { rowId: candidate.bRowId, record: candidate.bRecord });
      } else {
        onlyBById.delete(candidate.bRowId);
      }
    }
    const onlyB = [...onlyBById.values()];
    const primaryOnlyA = onlyA.filter((row) => !matchedA.has(row.rowId) && !reviewA.has(row.rowId));
    const primaryOnlyB = onlyB.filter((row) => !matchedB.has(row.rowId) && !reviewB.has(row.rowId));
    const reviewed = reviewQueue.filter((item) => item.state === "reviewed_same" || item.state === "reviewed_different").length;
    const deferred = reviewQueue.filter((item) => item.state === "deferred").length;
    const remaining = reviewQueue.filter((item) => item.state === "needs_review").length;
    const undoEntry = run.undoStack.at(-1);
    const undoDecision = undoEntry ? run.decisions.get(undoEntry.candidateIds[0]!) : undefined;
    const undoBlocked = undoEntry?.createdConflictIds.some((conflictId) => run.conflicts.get(conflictId)?.resolution) ?? false;
    const effectiveCandidateIds = new Set(effectiveLinks.map((candidate) => candidate.candidateId));
    const visibleConflicts = [...run.conflicts.values()].filter((conflict) => effectiveCandidateIds.has(conflict.candidateId));
    const readiness: TrustedExportReadiness = {
      ready: Boolean(result) && remaining === 0 && deferred === 0 && visibleConflicts.every((conflict) => conflict.resolution !== null),
      unresolvedIdentityCount: remaining + deferred,
      unresolvedConflictCount: visibleConflicts.filter((conflict) => !conflict.resolution).length,
      eligibleConfirmedCount: effectiveLinks.length,
      onlyACount: onlyA.length,
      onlyBCount: onlyB.length,
      blockers: [
        ...(!result ? ["The matcher has not completed."] : []),
        ...(remaining + deferred > 0 ? [`${remaining + deferred} identity review item(s) remain unresolved.`] : []),
        ...(visibleConflicts.some((conflict) => !conflict.resolution) ? [`${visibleConflicts.filter((conflict) => !conflict.resolution).length} comparison-field conflict(s) remain unresolved.`] : []),
      ],
    };
    return {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      runId: run.runId,
      stage: run.stage,
      datasets: {
        ...(run.datasets.A ? { A: run.datasets.A.profile } : {}),
        ...(run.datasets.B ? { B: run.datasets.B.profile } : {}),
      },
      mappings: run.mappings,
      mappingVersion: CONFIRMED_MAPPINGS_VERSION,
      semanticMappingProvenance: run.mappingProposal?.provenance ?? null,
      matcherVersion: result?.matcherVersion ?? null,
      matcherProvenance: result ? {
        matcherVersion: result.matcherVersion,
        candidateEngineVersion: result.candidateEngineVersion,
        blockingNormalizationVersion: result.blockingNormalizationVersion,
        featurePipelineVersion: result.featurePipelineVersion,
        matcherConfigVersion: result.matcherConfigVersion,
        matcherConfig: result.matcherConfig,
      } : null,
      summary: result ? { matched: matchedA.size, needsReview: reviewA.size, onlyA: primaryOnlyA.length, onlyB: primaryOnlyB.length } : null,
      candidates,
      decisions: [...run.decisions.values()],
      conflicts: visibleConflicts,
      survivorshipPolicy: run.survivorshipPolicy ?? null,
      trustedExportReadiness: readiness,
      reviewQueue,
      reviewProgress: { total: reviewQueue.length, reviewed, remaining, deferred },
      reviewUndo: undoDecision ? {
        decisionId: undoDecision.decisionId,
        candidateId: undoDecision.candidateId,
        aRowId: undoDecision.aRowId,
        bRowId: undoDecision.bRowId,
        humanDecision: undoDecision.humanDecision,
        canUndo: !undoBlocked,
        blockedReason: undoBlocked
          ? "A dependent field resolution exists. Revert it before undoing this identity decision."
          : null,
        decisionOrigin: undoEntry!.decisionOrigin,
        affectedCount: undoEntry!.candidateIds.length,
        reviewGroupId: undoEntry!.reviewGroupId,
      } : null,
      onlyA,
      onlyB,
    };
  }

  private reviewQueue(run: RunState, candidates: CandidatePair[]): ReviewQueueItem[] {
    const groups = new Map<string, CandidatePair[]>();
    for (const candidate of candidates) {
      const group = groups.get(candidate.aRowId) ?? [];
      group.push(candidate);
      groups.set(candidate.aRowId, group);
    }
    const decisions = [...run.decisions.values()];
    const queue: ReviewQueueItem[] = [];
    let sourceOrder = 0;
    for (const [aRowId, unsorted] of groups) {
      const options = [...unsorted].sort((left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId));
      const rowDecisions = decisions.filter((decision) => decision.aRowId === aRowId);
      const untouchedAutomatic = options.some((candidate) => candidate.rank === 1 && candidate.band === "auto_match") && rowDecisions.length === 0;
      if (untouchedAutomatic) continue;
      if (!options.some((candidate) => candidate.band === "needs_review") && rowDecisions.length === 0) continue;
      const sameDecision = rowDecisions.find((decision) => decision.humanDecision === "same_entity");
      const allDifferent = options.every((candidate) => run.decisions.get(candidate.candidateId)?.humanDecision === "different_entity");
      const current = (sameDecision ? options.find((candidate) => candidate.candidateId === sameDecision.candidateId) : null)
        ?? options.find((candidate) => !run.decisions.has(candidate.candidateId))
        ?? options[0]!;
      const isDeferred = !sameDecision && !allDifferent && run.deferredARowIds.has(aRowId);
      const state = sameDecision
        ? "reviewed_same" as const
        : allDifferent
          ? "reviewed_different" as const
          : isDeferred
            ? "deferred" as const
            : "needs_review" as const;
      const latestDecision = sameDecision ?? rowDecisions.at(-1) ?? null;
      const strongestPositive = [...current.evidence]
        .filter((evidence) => evidence.positiveContribution > 0)
        .sort((left, right) => right.positiveContribution - left.positiveContribution)[0] ?? null;
      const strongestContradiction = [...current.evidence]
        .filter((evidence) => evidence.conflictContribution > 0)
        .sort((left, right) => right.conflictContribution - left.conflictContribution)[0] ?? null;
      const collisionARowIds = [...new Set(candidates
        .filter((candidate) => candidate.bRowId === current.bRowId && candidate.aRowId !== aRowId)
        .map((candidate) => candidate.aRowId))].sort();
      queue.push({
        aRowId,
        candidateIds: options.map((candidate) => candidate.candidateId),
        topCandidateId: current.candidateId,
        topBRowId: current.bRowId,
        topMatchScore: current.matchScore,
        runnerUpMargin: current.runnerUpMargin,
        candidateCount: options.length,
        strongestPositive: strongestPositive ? {
          mappingId: strongestPositive.mappingId,
          label: strongestPositive.label,
          evidenceClass: strongestPositive.evidenceClass,
          contribution: strongestPositive.contribution,
        } : null,
        strongestContradiction: strongestContradiction ? {
          mappingId: strongestContradiction.mappingId,
          label: strongestContradiction.label,
          evidenceClass: strongestContradiction.evidenceClass,
          contribution: strongestContradiction.contribution,
        } : null,
        collision: current.collision || collisionARowIds.length > 0,
        collisionARowIds,
        strongContradiction: current.strongContradiction,
        state,
        deferred: isDeferred,
        humanDecision: latestDecision ? {
          candidateId: latestDecision.candidateId,
          bRowId: latestDecision.bRowId,
          humanDecision: latestDecision.humanDecision,
          decidedAt: latestDecision.decidedAt,
        } : null,
        matcherVersion: MATCHER_VERSION,
        sourceOrder,
      });
      sourceOrder += 1;
    }
    return queue;
  }
}

function defendFormula(value: string): string {
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const safe = defendFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function compareIds(left: string, right: string): number { return left.localeCompare(right, "en"); }

function effectiveLinks(view: RunView) {
  const candidateById = new Map(view.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const humanSame = view.decisions.filter((decision) => decision.humanDecision === "same_entity");
  const humanSameA = new Set(humanSame.map((decision) => decision.aRowId));
  const rejected = new Set(view.decisions.filter((decision) => decision.humanDecision === "different_entity").map((decision) => decision.candidateId));
  return [
    ...humanSame.map((decision) => ({ candidate: candidateById.get(decision.candidateId), source: "human", decision })),
    ...view.candidates
      .filter((candidate) => candidate.rank === 1 && candidate.band === "auto_match" && !humanSameA.has(candidate.aRowId) && !rejected.has(candidate.candidateId))
      .map((candidate) => ({ candidate, source: "system_matcher", decision: null })),
  ].filter((link): link is { candidate: CandidatePair; source: string; decision: IdentityDecision | null } => Boolean(link.candidate))
    .sort((left, right) => compareIds(left.candidate.aRowId, right.candidate.aRowId) || compareIds(left.candidate.bRowId, right.candidate.bRowId));
}

function resolutionOrigin(resolution: NonNullable<FieldConflict["resolution"]>): "manual" | "deterministic_rule" {
  return resolution.ruleId || resolution.resolutionSource === "rule" ? "deterministic_rule" : "manual";
}

function conflictKey(candidateId: string, mappingId: string): string { return `${candidateId}\0${mappingId}`; }

function baseReconciliationRow(view: RunView, candidate: CandidatePair | null, values: string[]): string[] {
  return [
    ...values,
    candidate?.candidateId ?? "",
    candidate?.matchScore.toString() ?? "",
    candidate?.collision ? "true" : "false",
    view.matcherVersion ?? "",
    view.matcherProvenance?.candidateEngineVersion ?? "",
    view.mappingVersion,
    view.datasets.A?.sha256 ?? "",
    view.datasets.B?.sha256 ?? "",
    view.survivorshipPolicy?.policyVersion ?? "manual-only",
    RECONCILIATION_EXPORT_VERSION,
  ];
}

function appendRawValues(row: string[], view: RunView, aRecord: Record<string, string>, bRecord: Record<string, string>): void {
  for (const mapping of view.mappings) row.push(aRecord[mapping.aColumn] ?? "", bRecord[mapping.bColumn] ?? "");
}

function appendIdentityNotApplicable(row: string[], comparisonCount: number, status: string, source: string, reason: string): void {
  row.push(...Array.from({ length: comparisonCount }, () => ["", "", "", status, "", source, source, reason, "", ""]).flat());
}

export function exportRun(view: RunView): string {
  if (!view.summary || !view.matcherVersion) throw new WorkflowError("run_not_matched", "Run the matcher before exporting.");
  const comparisonMappings = view.mappings.filter((mapping) => mapping.includeInMerge);
  const headers = [
    "a_row_id", "b_row_id", "identity_status", "identity_decision_source", "identity_decision_id", "identity_decided_at", "review_state",
    "candidate_id", "match_score", "collision", "matcher_version", "candidate_engine_version", "mapping_version", "source_a_sha256", "source_b_sha256",
    "survivorship_policy_version", "export_version",
  ];
  for (const mapping of view.mappings) headers.push(`a_${mapping.label}`, `b_${mapping.label}`);
  for (const mapping of comparisonMappings) headers.push(
    `resolved_${mapping.label}`, `conflict_id_${mapping.label}`, `resolution_id_${mapping.label}`, `field_status_${mapping.label}`,
    `resolution_strategy_${mapping.label}`, `resolution_source_${mapping.label}`, `resolution_origin_${mapping.label}`,
    `resolution_reason_${mapping.label}`, `survivorship_policy_version_${mapping.label}`, `survivorship_rule_id_${mapping.label}`,
  );

  const rows: string[][] = [];
  const conflictByKey = new Map(view.conflicts.map((conflict) => [conflictKey(conflict.candidateId, conflict.mappingId), conflict]));
  const candidateById = new Map(view.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const linkedA = new Set<string>();
  const linkedB = new Set<string>();

  for (const { candidate, source, decision } of effectiveLinks(view)) {
    if (linkedA.has(candidate.aRowId)) continue;
    linkedA.add(candidate.aRowId); linkedB.add(candidate.bRowId);
    const row = baseReconciliationRow(view, candidate, [
      candidate.aRowId, candidate.bRowId, "same_entity", source, decision?.decisionId ?? "", decision?.decidedAt ?? "",
      decision ? "reviewed_same" : "system_established",
    ]);
    appendRawValues(row, view, candidate.aRecord, candidate.bRecord);
    for (const mapping of comparisonMappings) {
      const conflict = conflictByKey.get(conflictKey(candidate.candidateId, mapping.mappingId));
      if (conflict?.resolution) {
        const resolution = conflict.resolution;
        row.push(resolution.chosenValue ?? "", conflict.conflictId, resolution.resolutionId, "resolved", resolution.strategy,
          resolution.resolutionSource, resolutionOrigin(resolution), resolution.reason, resolution.policyVersion ?? "", resolution.ruleId ?? "");
      } else if (conflict) {
        row.push("", conflict.conflictId, "", "unresolved", "", "unresolved", "unresolved", "No survivorship decision has been applied.", "", "");
      } else {
        row.push(candidate.aRecord[mapping.aColumn] ?? candidate.bRecord[mapping.bColumn] ?? "", "", "", "agreed", "agreed",
          "equal_sources", "source_equality", "Source values are equal.", "", "");
      }
    }
    rows.push(row);
  }

  for (const decision of [...view.decisions].filter((item) => item.humanDecision === "different_entity").sort((a, b) => compareIds(a.candidateId, b.candidateId))) {
    const candidate = candidateById.get(decision.candidateId);
    if (!candidate) continue;
    const queueState = view.reviewQueue.find((item) => item.aRowId === candidate.aRowId)?.state ?? "reviewed_different";
    const row = baseReconciliationRow(view, candidate, [candidate.aRowId, candidate.bRowId, "different_entity", "human", decision.decisionId, decision.decidedAt, queueState]);
    appendRawValues(row, view, candidate.aRecord, candidate.bRecord);
    appendIdentityNotApplicable(row, comparisonMappings.length, "not_applicable", "identity_different", "Human review determined that these records are different entities.");
    rows.push(row);
  }

  for (const review of [...view.reviewQueue].filter((item) => item.state === "needs_review" || item.state === "deferred").sort((a, b) => a.sourceOrder - b.sourceOrder || compareIds(a.aRowId, b.aRowId))) {
    const candidate = candidateById.get(review.topCandidateId);
    if (!candidate || linkedA.has(candidate.aRowId)) continue;
    linkedA.add(candidate.aRowId); linkedB.add(candidate.bRowId);
    const deferred = review.state === "deferred";
    const row = baseReconciliationRow(view, candidate, [candidate.aRowId, candidate.bRowId, deferred ? "deferred" : "needs_review", deferred ? "human_defer" : "pending_human_review", "", "", review.state]);
    appendRawValues(row, view, candidate.aRecord, candidate.bRecord);
    appendIdentityNotApplicable(row, comparisonMappings.length, "pending_identity", "unresolved", deferred ? "Identity review was explicitly deferred." : "Identity is not resolved.");
    rows.push(row);
  }

  for (const item of [...view.onlyA].sort((a, b) => compareIds(a.rowId, b.rowId))) {
    if (linkedA.has(item.rowId)) continue;
    const row = baseReconciliationRow(view, null, [item.rowId, "", "only_a", "none", "", "", "source_only"]);
    appendRawValues(row, view, item.record, {});
    appendIdentityNotApplicable(row, comparisonMappings.length, "not_applicable", "source_only_a", "No cross-source conflict.");
    rows.push(row);
  }
  for (const item of [...view.onlyB].sort((a, b) => compareIds(a.rowId, b.rowId))) {
    if (linkedB.has(item.rowId)) continue;
    const row = baseReconciliationRow(view, null, ["", item.rowId, "only_b", "none", "", "", "source_only"]);
    appendRawValues(row, view, {}, item.record);
    appendIdentityNotApplicable(row, comparisonMappings.length, "not_applicable", "source_only_b", "No cross-source conflict.");
    rows.push(row);
  }
  return csv([headers, ...rows]);
}

export function exportTrustedRun(view: RunView): string {
  if (!view.summary || !view.matcherVersion) throw new WorkflowError("run_not_matched", "Run the matcher before exporting.");
  if (!view.trustedExportReadiness.ready) {
    throw new WorkflowError("trusted_export_not_ready", `Trusted merged output is blocked: ${view.trustedExportReadiness.blockers.join(" ")}`, 409);
  }
  const comparisonMappings = view.mappings.filter((mapping) => mapping.includeInMerge);
  const headers = [
    "entity_provenance", "a_row_id", "b_row_id", "identity_source", "identity_decision_id", "mapping_version", "source_a_sha256", "source_b_sha256",
    "candidate_engine_version", "matcher_version", "survivorship_policy_version", "export_version",
  ];
  for (const mapping of comparisonMappings) headers.push(
    mapping.label, `${mapping.label}__A`, `${mapping.label}__B`, `${mapping.label}__resolution`, `${mapping.label}__resolution_source`,
    `${mapping.label}__resolution_origin`, `${mapping.label}__resolution_id`, `${mapping.label}__policy_version`, `${mapping.label}__rule_id`, `${mapping.label}__reason`,
  );
  const rows: string[][] = [];
  const conflictByKey = new Map(view.conflicts.map((conflict) => [conflictKey(conflict.candidateId, conflict.mappingId), conflict]));
  const linkedA = new Set<string>();
  const linkedB = new Set<string>();
  for (const { candidate, source, decision } of effectiveLinks(view)) {
    if (linkedA.has(candidate.aRowId)) continue;
    linkedA.add(candidate.aRowId); linkedB.add(candidate.bRowId);
    const row = ["confirmed_cross_source", candidate.aRowId, candidate.bRowId, source, decision?.decisionId ?? "", view.mappingVersion,
      view.datasets.A?.sha256 ?? "", view.datasets.B?.sha256 ?? "", view.matcherProvenance?.candidateEngineVersion ?? "", view.matcherVersion,
      view.survivorshipPolicy?.policyVersion ?? "manual-only", TRUSTED_EXPORT_VERSION];
    for (const mapping of comparisonMappings) {
      const aValue = candidate.aRecord[mapping.aColumn] ?? "";
      const bValue = candidate.bRecord[mapping.bColumn] ?? "";
      const conflict = conflictByKey.get(conflictKey(candidate.candidateId, mapping.mappingId));
      if (!conflict) {
        row.push(aValue, aValue, bValue, "agreed", "equal_sources", "source_equality", "", "", "", "Source values are equal.");
      } else {
        const resolution = conflict.resolution!;
        row.push(resolution.chosenValue ?? "", aValue, bValue, resolution.strategy, resolution.resolutionSource, resolutionOrigin(resolution),
          resolution.resolutionId, resolution.policyVersion ?? "", resolution.ruleId ?? "", resolution.reason);
      }
    }
    rows.push(row);
  }
  for (const item of [...view.onlyA].sort((a, b) => compareIds(a.rowId, b.rowId))) {
    if (linkedA.has(item.rowId)) continue;
    const row = ["source_only_a", item.rowId, "", "none", "", view.mappingVersion, view.datasets.A?.sha256 ?? "", view.datasets.B?.sha256 ?? "",
      view.matcherProvenance?.candidateEngineVersion ?? "", view.matcherVersion, view.survivorshipPolicy?.policyVersion ?? "manual-only", TRUSTED_EXPORT_VERSION];
    for (const mapping of comparisonMappings) {
      const value = item.record[mapping.aColumn] ?? "";
      row.push(value, value, "", "source_only_a", "source_only_a", "source_only_a", "", "", "", "No cross-source conflict.");
    }
    rows.push(row);
  }
  for (const item of [...view.onlyB].sort((a, b) => compareIds(a.rowId, b.rowId))) {
    if (linkedB.has(item.rowId)) continue;
    const row = ["source_only_b", "", item.rowId, "none", "", view.mappingVersion, view.datasets.A?.sha256 ?? "", view.datasets.B?.sha256 ?? "",
      view.matcherProvenance?.candidateEngineVersion ?? "", view.matcherVersion, view.survivorshipPolicy?.policyVersion ?? "manual-only", TRUSTED_EXPORT_VERSION];
    for (const mapping of comparisonMappings) {
      const value = item.record[mapping.bColumn] ?? "";
      row.push(value, "", value, "source_only_b", "source_only_b", "source_only_b", "", "", "", "No cross-source conflict.");
    }
    rows.push(row);
  }
  return csv([headers, ...rows]);
}

function safeRunToken(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").slice(0, 120);
  return safe || "run";
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareIds(left, right)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function timestampRange(values: string[]): { first: string | null; last: string | null } {
  const sorted = [...values].sort(compareIds);
  return { first: sorted[0] ?? null, last: sorted.at(-1) ?? null };
}

export interface RunExportSnapshot {
  reconciliation: { filename: string; content: string };
  trusted: { filename: string; content: string } | null;
  manifest: { filename: string; content: string; value: RunManifest };
}

export function buildExportSnapshot(view: RunView, mappingProposal?: SemanticMappingProposal): RunExportSnapshot {
  if (!view.summary || !view.matcherProvenance || !view.datasets.A || !view.datasets.B) {
    throw new WorkflowError("run_not_matched", "Run the matcher before exporting.");
  }
  const token = safeRunToken(view.runId);
  const reconciliation = { filename: `samewise-${token}-reconciliation.csv`, content: exportRun(view) };
  const trusted = view.trustedExportReadiness.ready
    ? { filename: `samewise-${token}-trusted-merged.csv`, content: exportTrustedRun(view) }
    : null;
  const artifacts = [
    { kind: "reconciliation_report" as const, version: RECONCILIATION_EXPORT_VERSION, filename: reconciliation.filename,
      mediaType: "text/csv; charset=utf-8" as const, sha256: sha256(reconciliation.content), byteLength: Buffer.byteLength(reconciliation.content, "utf8") },
    ...(trusted ? [{ kind: "trusted_merged_output" as const, version: TRUSTED_EXPORT_VERSION, filename: trusted.filename,
      mediaType: "text/csv; charset=utf-8" as const, sha256: sha256(trusted.content), byteLength: Buffer.byteLength(trusted.content, "utf8") }] : []),
  ];
  const decisions = timestampRange(view.decisions.map((decision) => decision.decidedAt));
  const resolutions = timestampRange(view.conflicts.flatMap((conflict) => conflict.resolution ? [conflict.resolution.resolvedAt] : []));
  const links = effectiveLinks(view);
  const resolved = view.conflicts.flatMap((conflict) => conflict.resolution ? [conflict.resolution] : []);
  const semanticAi = mappingProposal ? {
    provider: mappingProposal.provenance.provider,
    model: mappingProposal.provenance.model,
    promptVersion: mappingProposal.provenance.promptVersion,
    structuredOutputSchemaVersion: mappingProposal.provenance.schemaVersion,
    requestVersion: mappingProposal.provenance.requestVersion,
    responseId: mappingProposal.provenance.responseId,
    proposalId: mappingProposal.proposalId,
    createdAt: mappingProposal.createdAt,
    suggestionDecisions: mappingProposal.suggestions.map((suggestion) => ({
      suggestionId: suggestion.suggestionId, status: suggestion.status, proposedAColumn: suggestion.leftColumn,
      proposedBColumn: suggestion.rightColumn, finalMappingId: suggestion.finalMapping?.mappingId ?? null,
    })).sort((a, b) => compareIds(a.suggestionId, b.suggestionId)),
  } : null;
  const manifest: RunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    run: {
      runId: view.runId,
      status: view.trustedExportReadiness.ready ? "trusted_ready"
        : view.trustedExportReadiness.unresolvedIdentityCount > 0 ? "identity_unresolved"
          : view.trustedExportReadiness.unresolvedConflictCount > 0 ? "conflicts_unresolved" : "matched",
      stage: view.stage,
      snapshot: { descriptorVersion: EXPORT_SNAPSHOT_VERSION, authoritativeStateSha256: sha256(JSON.stringify(canonicalize({ view, semanticAi }))) },
      relevantTimestamps: {
        mappingProposalCreatedAt: mappingProposal?.createdAt ?? null,
        firstIdentityDecisionAt: decisions.first,
        lastIdentityDecisionAt: decisions.last,
        policyConfiguredAt: view.survivorshipPolicy?.configuredAt ?? null,
        lastResolutionAt: resolutions.last,
      },
    },
    sourceDatasets: {
      A: { side: "A", datasetId: view.datasets.A.datasetId, originalFilename: view.datasets.A.originalFilename, sha256: view.datasets.A.sha256, rowCount: view.datasets.A.rowCount, profileSchemaVersion: view.datasets.A.contractVersion },
      B: { side: "B", datasetId: view.datasets.B.datasetId, originalFilename: view.datasets.B.originalFilename, sha256: view.datasets.B.sha256, rowCount: view.datasets.B.rowCount, profileSchemaVersion: view.datasets.B.contractVersion },
    },
    semanticMapping: {
      mappingVersion: view.mappingVersion,
      confirmedMappings: view.mappings,
      ai: semanticAi,
    },
    candidateGeneration: {
      candidateEngineVersion: view.matcherProvenance.candidateEngineVersion,
      blockingNormalizationVersion: view.matcherProvenance.blockingNormalizationVersion,
      candidateConfigVersion: view.matcherProvenance.candidateEngineVersion,
      candidateConfigAvailability: "retained_in_evidence_plan",
      evidencePlanVersion: view.matcherProvenance.evidencePlanVersion ?? "evidence-plan-v1.0.0",
      evidencePlanSha256: sha256(JSON.stringify(canonicalize(view.matcherProvenance.evidencePlan ?? {}))),
      evidencePlan: view.matcherProvenance.evidencePlan ?? {},
    },
    matcher: {
      featurePipelineVersion: view.matcherProvenance.featurePipelineVersion,
      matcherVersion: view.matcherProvenance.matcherVersion,
      matcherConfigVersion: view.matcherProvenance.matcherConfigVersion,
      matcherConfig: view.matcherProvenance.matcherConfig,
      scoreSemanticsVersion: view.matcherProvenance.matcherVersion,
    },
    identity: {
      systemEstablishedLinkCount: links.filter((link) => link.source === "system_matcher").length,
      humanSameCount: view.decisions.filter((decision) => decision.humanDecision === "same_entity").length,
      humanDifferentCount: view.decisions.filter((decision) => decision.humanDecision === "different_entity").length,
      pendingCount: view.reviewQueue.filter((item) => item.state === "needs_review").length,
      deferredCount: view.reviewQueue.filter((item) => item.state === "deferred").length,
      collisionRelatedCount: view.reviewQueue.filter((item) => item.collision).length,
      humanBatchPairCount: view.decisions.filter((decision) => decision.decisionOrigin === "human_batch_rule").length,
      reviewSignatureVersion: REVIEW_SIGNATURE_VERSION,
    },
    survivorship: {
      policySchemaVersion: SURVIVORSHIP_POLICY_SCHEMA_VERSION,
      policyVersion: view.survivorshipPolicy?.policyVersion ?? null,
      configuredFieldPolicies: view.survivorshipPolicy?.fieldPolicies ?? [],
      manualResolutionCount: resolved.filter((resolution) => resolutionOrigin(resolution) === "manual").length,
      ruleGeneratedResolutionCount: resolved.filter((resolution) => resolutionOrigin(resolution) === "deterministic_rule").length,
      keepBothCount: resolved.filter((resolution) => resolution.strategy === "keep_both").length,
      unresolvedConflictCount: view.trustedExportReadiness.unresolvedConflictCount,
    },
    evaluation: { applicable: false, snapshotId: null, snapshotVersion: null, reason: "No versioned evaluation snapshot is attached to this ordinary product run." },
    export: { artifacts },
  };
  return {
    reconciliation,
    trusted,
    manifest: { filename: `samewise-${token}-manifest.json`, value: manifest, content: `${JSON.stringify(manifest, null, 2)}\n` },
  };
}
