import { z } from "zod";

export const EVALUATION_SNAPSHOT_VERSION = "evaluation-snapshot-v1.0.0" as const;
export const EVALUATION_VERSION = "matcher-evaluation-v0.3.0" as const;
export const EvaluationSourceTypeSchema = z.enum([
  "SYNTHETIC_GROUND_TRUTH",
  "HUMAN_REVIEW_LABELS",
]);

export const EvaluationMetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.number().min(0).max(1).nullable(),
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  unit: z.literal("ratio"),
  level: z.enum(["pair", "a_row", "search_space"]),
  description: z.string().min(1),
}).strict();
export type EvaluationMetric = z.infer<typeof EvaluationMetricSchema>;

const GateCheckSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  actual: z.number().nullable(),
  expected: z.number(),
}).strict();

const ScoreBandSchema = z.object({
  band: z.string().min(1),
  candidateCount: z.number().int().nonnegative(),
  trueMatchCount: z.number().int().nonnegative(),
  falseMatchCount: z.number().int().nonnegative(),
  empiricalMatchRate: z.number().min(0).max(1).nullable(),
}).strict();

const ThresholdAnalysisSchema = z.object({
  threshold: z.number().min(0).max(1),
  autoMatchCount: z.number().int().nonnegative(),
  autoMatchPrecision: z.number().min(0).max(1).nullable(),
  autoMatchRecall: z.number().min(0).max(1).nullable(),
  reviewRate: z.number().min(0).max(1).nullable(),
  falseAutoMatches: z.number().int().nonnegative(),
}).strict();

export const EvaluationSnapshotSchema = z.object({
  snapshotVersion: z.literal(EVALUATION_SNAPSHOT_VERSION),
  evaluationVersion: z.literal(EVALUATION_VERSION),
  id: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({
    type: EvaluationSourceTypeSchema,
    id: z.string().min(1),
    label: z.string().min(1),
    representative: z.boolean(),
    caveat: z.string().min(1),
  }).strict(),
  fixture: z.object({
    name: z.string().min(1),
    seed: z.number().int(),
    aRows: z.number().int().nonnegative(),
    bRows: z.number().int().nonnegative(),
    theoreticalPairs: z.number().int().nonnegative(),
  }).strict(),
  provenance: z.object({
    datasetFingerprints: z.object({ dataset_a: z.string().length(64), dataset_b: z.string().length(64) }).strict(),
    mappingVersion: z.string().min(1),
    candidateEngineVersion: z.string().min(1),
    candidateConfigHash: z.string().length(64),
    featurePipelineVersion: z.string().min(1),
    matcherVersion: z.string().min(1),
    matcherConfigVersion: z.string().min(1),
    matcherConfigHash: z.string().length(64),
  }).strict(),
  metrics: z.array(EvaluationMetricSchema).min(1),
  counts: z.object({
    candidatePairs: z.number().int().nonnegative(),
    trueLinks: z.number().int().nonnegative(),
    candidateMisses: z.number().int().nonnegative(),
    featureScoredTrueLinks: z.number().int().nonnegative(),
    postCandidateLosses: z.number().int().nonnegative(),
    recoverableTrueLinks: z.number().int().nonnegative(),
    autoMatches: z.number().int().nonnegative(),
    trueAutoMatches: z.number().int().nonnegative(),
    falseAutoMatches: z.number().int().nonnegative(),
    reviewRoutedARows: z.number().int().nonnegative(),
    unmatchedMatchableARows: z.number().int().nonnegative(),
    hardNegativeAutoMatches: z.number().int().nonnegative(),
  }).strict(),
  decomposition: z.object({
    pairLevel: z.object({
      trueLinks: z.number().int().nonnegative(),
      candidateRetained: z.number().int().nonnegative(),
      featureScored: z.number().int().nonnegative(),
      recoverable: z.number().int().nonnegative(),
      autoMatched: z.number().int().nonnegative(),
    }).strict(),
    aRowLevel: z.object({
      matchable: z.number().int().nonnegative(),
      autoMatched: z.number().int().nonnegative(),
      reviewRouted: z.number().int().nonnegative(),
      unmatched: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  scoreBands: z.array(ScoreBandSchema),
  scoreBandNotice: z.string().min(1),
  thresholdAnalysis: z.array(ThresholdAnalysisSchema),
  thresholdAnalysisNotice: z.string().min(1),
  errorSummary: z.record(z.string(), z.number().int().nonnegative()),
  gateResult: z.object({
    configVersion: z.string().min(1),
    passed: z.boolean(),
    checks: z.array(GateCheckSchema),
  }).strict(),
  artifactHashes: z.record(z.string(), z.string().length(64)),
}).strict();
export type EvaluationSnapshot = z.infer<typeof EvaluationSnapshotSchema>;

export const EvaluationComparisonSchema = z.object({
  comparisonVersion: z.literal("evaluation-comparison-v1.0.0"),
  snapshotA: z.string().min(1),
  snapshotB: z.string().min(1),
  compatible: z.boolean(),
  status: z.enum(["Comparable", "Not directly comparable."]),
  reasons: z.array(z.string()),
  metrics: z.array(z.object({
    metricId: z.string().min(1),
    label: z.string().min(1),
    versionA: z.number().min(0).max(1).nullable(),
    versionB: z.number().min(0).max(1).nullable(),
    delta: z.number().min(-1).max(1).nullable(),
    deltaUnit: z.literal("percentage_points"),
  }).strict()),
}).strict();
export type EvaluationComparison = z.infer<typeof EvaluationComparisonSchema>;

export const EvaluationCatalogSchema = z.object({
  catalogVersion: z.literal("evaluation-catalog-v1.0.0"),
  snapshots: z.array(EvaluationSnapshotSchema),
  comparisons: z.array(EvaluationComparisonSchema),
  relatedBenchmarks: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    sourceType: z.literal("SYNTHETIC_GROUND_TRUTH"),
    fixtureName: z.string().min(1),
    evaluationVersion: z.string().min(1),
    candidateEngineVersion: z.string().min(1),
    candidateCount: z.number().int().nonnegative(),
    candidateRecall: z.object({ numerator: z.number().int().nonnegative(), denominator: z.number().int().positive(), value: z.number().min(0).max(1) }).strict(),
    weakIdentifierRecall: z.object({ numerator: z.number().int().nonnegative(), denominator: z.number().int().positive(), value: z.number().min(0).max(1) }).strict(),
    caveat: z.string().min(1),
  }).strict()),
}).strict();
export type EvaluationCatalog = z.infer<typeof EvaluationCatalogSchema>;

export const EvaluationErrorSchema = z.object({
  id: z.string().min(1),
  group: z.enum(["candidate_misses", "ranking_losses", "post_score_losses", "false_auto_matches", "false_unmatched", "hard_negatives"]),
  taxonomyVersion: z.literal("evaluation-error-taxonomy-v1.0.0"),
  category: z.string().min(1),
  aRowId: z.string().min(1),
  bRowId: z.string().min(1),
  aRecord: z.record(z.string(), z.string()),
  bRecord: z.record(z.string(), z.string()),
  evaluationOnlyTruth: z.object({ label: z.enum(["SAME", "DIFFERENT"]), notice: z.string().min(1) }).strict(),
}).catchall(z.unknown());
export type EvaluationError = z.infer<typeof EvaluationErrorSchema>;

export const EvaluationErrorPageSchema = z.object({
  snapshotId: z.string().min(1),
  group: EvaluationErrorSchema.shape.group,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
  items: z.array(EvaluationErrorSchema),
}).strict();
export type EvaluationErrorPage = z.infer<typeof EvaluationErrorPageSchema>;

export const HumanReviewEvidenceSchema = z.object({
  source: z.object({
    type: z.literal("HUMAN_REVIEW_LABELS"),
    representative: z.literal(false),
    caveat: z.literal("These labels come from cases selected for review and may not represent the full dataset distribution."),
  }).strict(),
  labeledCandidateCount: z.number().int().nonnegative(),
  sameLabels: z.number().int().nonnegative(),
  differentLabels: z.number().int().nonnegative(),
  systemProposalEligibleCount: z.number().int().nonnegative(),
  systemProposalAgreementCount: z.number().int().nonnegative(),
  systemProposalAgreementRate: z.number().min(0).max(1).nullable(),
  autoProposedSameRejected: z.number().int().nonnegative(),
  topCandidateLabels: z.number().int().nonnegative(),
  alternateCandidateLabels: z.number().int().nonnegative(),
  matcherVersions: z.array(z.string().min(1)),
  candidateEngineVersions: z.array(z.string().min(1)),
  labels: z.array(z.object({
    decisionId: z.string().min(1), candidateId: z.string().min(1), aRowId: z.string().min(1), bRowId: z.string().min(1),
    humanLabel: z.enum(["SAME", "DIFFERENT"]), systemProposal: z.enum(["auto_match", "needs_review"]),
    matchScore: z.number().min(0).max(1), matcherVersion: z.string().min(1), candidateEngineVersion: z.string().min(1),
    decidedAt: z.string().datetime(), rank: z.number().int().positive(), evidenceShown: z.array(z.unknown()).min(1),
  }).strict()),
}).strict();
export type HumanReviewEvidence = z.infer<typeof HumanReviewEvidenceSchema>;
