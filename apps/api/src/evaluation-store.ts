import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EvaluationCatalogSchema,
  EvaluationErrorPageSchema,
  HumanReviewEvidenceSchema,
  type EvaluationCatalog,
  type EvaluationErrorPage,
  type HumanReviewEvidence,
  type RunView,
} from "@samewise/contracts";

const REVIEWED_SUBSET_CAVEAT = "These labels come from cases selected for review and may not represent the full dataset distribution." as const;

export class EvaluationStore {
  private catalogPromise: Promise<EvaluationCatalog> | null = null;
  private readonly errors = new Map<string, Promise<unknown[]>>();

  constructor(private readonly root: string) {}

  catalog(): Promise<EvaluationCatalog> {
    this.catalogPromise ??= readFile(join(this.root, "catalog.json"), "utf8")
      .then((text) => EvaluationCatalogSchema.parse(JSON.parse(text)));
    return this.catalogPromise;
  }

  async snapshot(snapshotId: string) {
    return (await this.catalog()).snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;
  }

  async comparison(snapshotId: string, otherId: string) {
    return (await this.catalog()).comparisons.find((comparison) =>
      comparison.snapshotA === snapshotId && comparison.snapshotB === otherId
      || comparison.snapshotA === otherId && comparison.snapshotB === snapshotId) ?? null;
  }

  async errorPage(snapshotId: string, group: EvaluationErrorPage["group"], offset: number, limit: number): Promise<EvaluationErrorPage> {
    if (!await this.snapshot(snapshotId)) throw new Error("evaluation_not_found");
    let pending = this.errors.get(snapshotId);
    if (!pending) {
      pending = readFile(join(this.root, snapshotId, "errors.json"), "utf8").then((text) => JSON.parse(text) as unknown[]);
      this.errors.set(snapshotId, pending);
    }
    const selected = (await pending).filter((item) =>
      typeof item === "object" && item !== null && "group" in item && item.group === group);
    return EvaluationErrorPageSchema.parse({
      snapshotId, group, offset, limit, total: selected.length, items: selected.slice(offset, offset + limit),
    });
  }
}

export function humanReviewEvidence(run: RunView): HumanReviewEvidence {
  const candidates = new Map(run.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const labels = run.decisions.map((decision) => ({
    decisionId: decision.decisionId,
    candidateId: decision.candidateId,
    aRowId: decision.aRowId,
    bRowId: decision.bRowId,
    humanLabel: decision.humanDecision === "same_entity" ? "SAME" as const : "DIFFERENT" as const,
    systemProposal: decision.systemProposal,
    matchScore: decision.matchScore,
    matcherVersion: decision.matcherVersion,
    candidateEngineVersion: decision.candidateEngineVersion,
    decidedAt: decision.decidedAt,
    rank: candidates.get(decision.candidateId)?.rank ?? 1,
    evidenceShown: decision.evidenceShown,
  }));
  const proposalEligible = labels.filter((label) => label.systemProposal === "auto_match");
  const agreement = proposalEligible.filter((label) => label.humanLabel === "SAME");
  return HumanReviewEvidenceSchema.parse({
    source: { type: "HUMAN_REVIEW_LABELS", representative: false, caveat: REVIEWED_SUBSET_CAVEAT },
    labeledCandidateCount: labels.length,
    sameLabels: labels.filter((label) => label.humanLabel === "SAME").length,
    differentLabels: labels.filter((label) => label.humanLabel === "DIFFERENT").length,
    systemProposalEligibleCount: proposalEligible.length,
    systemProposalAgreementCount: agreement.length,
    systemProposalAgreementRate: proposalEligible.length ? agreement.length / proposalEligible.length : null,
    autoProposedSameRejected: proposalEligible.filter((label) => label.humanLabel === "DIFFERENT").length,
    topCandidateLabels: labels.filter((label) => label.rank === 1).length,
    alternateCandidateLabels: labels.filter((label) => label.rank > 1).length,
    matcherVersions: [...new Set(labels.map((label) => label.matcherVersion))].sort(),
    candidateEngineVersions: [...new Set(labels.map((label) => label.candidateEngineVersion))].sort(),
    labels,
  });
}
