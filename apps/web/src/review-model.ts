import type { CandidatePair } from "@samewise/contracts";

export function evidenceStateLabel(candidate: CandidatePair, mappingId: string): string {
  const evidence = candidate.evidence.find((item) => item.mappingId === mappingId);
  if (!evidence) return "Evidence unavailable";
  if (evidence.evidenceClass === "exact_agreement") return "Exact";
  if (evidence.evidenceClass === "partial_agreement") {
    const strongestFeature = Math.max(0, ...evidence.features.map((feature) => feature.value));
    return strongestFeature >= 0.85 ? "Strong agreement" : "Partial agreement";
  }
  if (evidence.evidenceClass === "conflict") return "Conflict";
  if (evidence.evidenceClass === "missing_left") return "Missing A";
  if (evidence.evidenceClass === "missing_right") return "Missing B";
  return "Missing both";
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, [contenteditable='true']") || !!target.closest("[contenteditable='true']");
}
