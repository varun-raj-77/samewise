import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import {
  MATCHER_VERSION,
  SEMANTIC_MAPPING_CONTRACT_VERSION,
  SEMANTIC_MAPPING_PROMPT_VERSION,
  SEMANTIC_MAPPING_REQUEST_VERSION,
  WORKFLOW_CONTRACT_VERSION,
  type CandidatePair,
  type DatasetProfile,
  type DatasetSide,
  type FieldConflict,
  type IdentityDecision,
  type ManualMapping,
  type MatcherResult,
  type MappingSuggestionDecision,
  type MappingSuggestionResponse,
  type RunView,
  type SemanticMappingProposal,
} from "@samewise/contracts";

import type { MatcherRunner } from "./matcher-process.js";
import {
  buildMetadataFirstInput,
  SemanticMapperError,
  validateModelOutput,
  type SemanticMapper,
} from "./semantic-mapper.js";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;

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
  mappingProposal?: SemanticMappingProposal;
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

function comparisonConflicts(run: RunState, candidate: CandidatePair): FieldConflict[] {
  return run.mappings
    .filter((mapping) => mapping.role === "comparison")
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
      resolution: null,
    }));
}

export class WorkflowStore {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly dataRoot: string,
    private readonly matcher: MatcherRunner,
    private readonly semanticMapper: SemanticMapper,
  ) {}

  createRun(): RunView {
    const run: RunState = {
      runId: `run-${randomUUID()}`,
      stage: "upload",
      datasets: {},
      mappings: [],
      decisions: new Map(),
      conflicts: new Map(),
    };
    this.runs.set(run.runId, run);
    return this.view(run);
  }

  private requireRun(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowError("run_not_found", "Run was not found.", 404);
    return run;
  }

  async upload(runId: string, side: DatasetSide, filenameHeader: string | undefined, bytes: Buffer): Promise<RunView> {
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
    return this.view(run);
  }

  setMappings(runId: string, mappings: ManualMapping[]): RunView {
    const run = this.requireRun(runId);
    const a = run.datasets.A?.profile;
    const b = run.datasets.B?.profile;
    if (!a || !b) throw new WorkflowError("datasets_required", "Upload both datasets before mapping columns.");
    if (!mappings.some((mapping) => mapping.role === "identity")) {
      throw new WorkflowError("identity_mapping_required", "Add at least one identity-evidence mapping.");
    }
    const aColumns = new Set(a.columns.map((column) => column.name));
    const bColumns = new Set(b.columns.map((column) => column.name));
    const ids = new Set<string>();
    const pairs = new Set<string>();
    for (const mapping of mappings) {
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
    run.mappings = mappings;
    delete run.result;
    run.decisions.clear();
    run.conflicts.clear();
    run.stage = "mapping";
    return this.view(run);
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
      ? decision.finalMapping!
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
      role: suggestion.role,
      normalizer,
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

  async match(runId: string): Promise<RunView> {
    const run = this.requireRun(runId);
    if (!run.datasets.A || !run.datasets.B || !run.mappings.some((mapping) => mapping.role === "identity")) {
      throw new WorkflowError("run_not_ready", "Both datasets and an identity mapping are required.");
    }
    run.result = await this.matcher.match({
      aPath: run.datasets.A.path,
      bPath: run.datasets.B.path,
      mappings: run.mappings,
    });
    run.decisions.clear();
    run.conflicts.clear();
    for (const candidate of run.result.candidates.filter((item) => item.rank === 1 && item.band === "auto_match")) {
      for (const conflict of comparisonConflicts(run, candidate)) run.conflicts.set(conflict.conflictId, conflict);
    }
    run.stage = "results";
    return this.view(run);
  }

  decide(runId: string, candidateId: string, humanDecision: "same_entity" | "different_entity"): RunView {
    const run = this.requireRun(runId);
    const candidate = run.result?.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new WorkflowError("candidate_not_found", "Candidate was not found.", 404);
    if (run.decisions.has(candidateId)) throw new WorkflowError("decision_exists", "This candidate already has a recorded decision.", 409);
    if (humanDecision === "same_entity") {
      const existingSame = [...run.decisions.values()].some((decision) => decision.aRowId === candidate.aRowId && decision.humanDecision === "same_entity");
      if (existingSame) throw new WorkflowError("identity_already_confirmed", "This A row already has a confirmed identity.", 409);
    }
    run.decisions.set(candidateId, {
      decisionId: `decision-${randomUUID()}`,
      runId,
      candidateId,
      aRowId: candidate.aRowId,
      bRowId: candidate.bRowId,
      systemProposal: candidate.band,
      humanDecision,
      matcherVersion: MATCHER_VERSION,
      evidenceShown: candidate.evidence,
      decidedAt: new Date().toISOString(),
    });
    if (humanDecision === "same_entity") {
      for (const conflict of comparisonConflicts(run, candidate)) run.conflicts.set(conflict.conflictId, conflict);
      run.stage = run.conflicts.size ? "resolution" : "review";
    } else {
      run.stage = "review";
    }
    return this.view(run);
  }

  resolveConflict(runId: string, conflictId: string, action: "use_a" | "use_b"): RunView {
    const run = this.requireRun(runId);
    const conflict = run.conflicts.get(conflictId);
    if (!conflict) throw new WorkflowError("conflict_not_found", "Field conflict was not found.", 404);
    if (conflict.resolution) throw new WorkflowError("resolution_exists", "This conflict is already resolved.", 409);
    conflict.resolution = {
      resolutionId: `resolution-${randomUUID()}`,
      chosenSource: action === "use_a" ? "A" : "B",
      chosenValue: action === "use_a" ? conflict.aValue : conflict.bValue,
      action,
      resolvedAt: new Date().toISOString(),
    };
    run.stage = "resolution";
    return this.view(run);
  }

  get(runId: string): RunView { return this.view(this.requireRun(runId)); }

  private view(run: RunState): RunView {
    const result = run.result;
    const candidates = result?.candidates ?? [];
    const aRows = new Set(candidates.map((candidate) => candidate.aRowId));
    const humanSameByA = new Map(
      [...run.decisions.values()]
        .filter((decision) => decision.humanDecision === "same_entity")
        .map((decision) => [decision.aRowId, decision]),
    );
    const rejectedCandidates = new Set(
      [...run.decisions.values()]
        .filter((decision) => decision.humanDecision === "different_entity")
        .map((decision) => decision.candidateId),
    );
    const effectiveLinks = [
      ...candidates.filter((candidate) => {
        const decision = humanSameByA.get(candidate.aRowId);
        return decision?.candidateId === candidate.candidateId;
      }),
      ...candidates.filter((candidate) =>
        candidate.rank === 1
        && candidate.band === "auto_match"
        && !humanSameByA.has(candidate.aRowId)
        && !rejectedCandidates.has(candidate.candidateId)),
    ];
    const matchedA = new Set<string>();
    const matchedB = new Set<string>();
    for (const candidate of effectiveLinks) {
      matchedA.add(candidate.aRowId); matchedB.add(candidate.bRowId);
    }
    const reviewA = new Set<string>();
    for (const aRowId of aRows) {
      if (matchedA.has(aRowId)) continue;
      const options = candidates.filter((candidate) => candidate.aRowId === aRowId);
      if (options.some((candidate) => !run.decisions.has(candidate.candidateId))) reviewA.add(aRowId);
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
    return {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      runId: run.runId,
      stage: run.stage,
      datasets: {
        ...(run.datasets.A ? { A: run.datasets.A.profile } : {}),
        ...(run.datasets.B ? { B: run.datasets.B.profile } : {}),
      },
      mappings: run.mappings,
      mappingVersion: "confirmed-mappings-v1",
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
      summary: result ? { matched: matchedA.size, needsReview: reviewA.size, onlyA: onlyA.length, onlyB: onlyB.length } : null,
      candidates,
      decisions: [...run.decisions.values()],
      conflicts: [...run.conflicts.values()],
      onlyA,
      onlyB,
    };
  }
}

function defendFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const safe = defendFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportRun(view: RunView): string {
  if (!view.summary || !view.matcherVersion) throw new WorkflowError("run_not_matched", "Run the matcher before exporting.");
  const comparisonMappings = view.mappings.filter((mapping) => mapping.role === "comparison");
  const headers = ["a_row_id", "b_row_id", "identity_status", "identity_decision_source", "matcher_version"];
  for (const mapping of view.mappings) headers.push(`a_${mapping.label}`, `b_${mapping.label}`);
  for (const mapping of comparisonMappings) headers.push(`resolved_${mapping.label}`, `resolution_status_${mapping.label}`);
  const rows: string[][] = [];
  const linkedA = new Set<string>();
  const linkedB = new Set<string>();
  const primary = view.candidates.filter((candidate) => candidate.rank === 1 && candidate.band === "auto_match");
  const humanSame = view.decisions.filter((decision) => decision.humanDecision === "same_entity");
  const links = [
    ...primary.filter((candidate) => !view.decisions.some((decision) => decision.candidateId === candidate.candidateId && decision.humanDecision === "different_entity"))
      .map((candidate) => ({ candidate, source: "system_matcher" })),
    ...humanSame.map((decision) => ({ candidate: view.candidates.find((candidate) => candidate.candidateId === decision.candidateId)!, source: "human" })),
  ].filter((link) => link.candidate);
  for (const { candidate, source } of links) {
    if (linkedA.has(candidate.aRowId)) continue;
    linkedA.add(candidate.aRowId); linkedB.add(candidate.bRowId);
    const row = [candidate.aRowId, candidate.bRowId, "same_entity", source, view.matcherVersion];
    for (const mapping of view.mappings) row.push(candidate.aRecord[mapping.aColumn] ?? "", candidate.bRecord[mapping.bColumn] ?? "");
    for (const mapping of comparisonMappings) {
      const conflict = view.conflicts.find((item) => item.candidateId === candidate.candidateId && item.mappingId === mapping.mappingId);
      if (conflict?.resolution) row.push(conflict.resolution.chosenValue, `resolved_use_${conflict.resolution.chosenSource.toLowerCase()}`);
      else if (conflict) row.push("", "unresolved");
      else row.push(candidate.aRecord[mapping.aColumn] ?? candidate.bRecord[mapping.bColumn] ?? "", "agreed");
    }
    rows.push(row);
  }
  const decidedCandidates = new Set(view.decisions.map((decision) => decision.candidateId));
  const reviewA = new Set(view.candidates.map((candidate) => candidate.aRowId).filter((rowId) => !linkedA.has(rowId)));
  for (const aRowId of reviewA) {
    const candidate = view.candidates
      .filter((item) => item.aRowId === aRowId && !decidedCandidates.has(item.candidateId))
      .sort((left, right) => left.rank - right.rank)[0];
    if (!candidate) continue;
    linkedA.add(candidate.aRowId); linkedB.add(candidate.bRowId);
    const row = [candidate.aRowId, candidate.bRowId, "needs_review", "pending_human_review", view.matcherVersion];
    for (const mapping of view.mappings) row.push(candidate.aRecord[mapping.aColumn] ?? "", candidate.bRecord[mapping.bColumn] ?? "");
    row.push(...comparisonMappings.flatMap(() => ["", "pending_identity"]));
    rows.push(row);
  }
  for (const item of view.onlyA) {
    if (linkedA.has(item.rowId)) continue;
    const row = [item.rowId, "", "only_a", "none", view.matcherVersion];
    for (const mapping of view.mappings) row.push(item.record[mapping.aColumn] ?? "", "");
    row.push(...comparisonMappings.flatMap(() => ["", "not_applicable"]));
    rows.push(row);
  }
  for (const item of view.onlyB) {
    if (linkedB.has(item.rowId)) continue;
    const row = ["", item.rowId, "only_b", "none", view.matcherVersion];
    for (const mapping of view.mappings) row.push("", item.record[mapping.bColumn] ?? "");
    row.push(...comparisonMappings.flatMap(() => ["", "not_applicable"]));
    rows.push(row);
  }
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
