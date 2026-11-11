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

export function isReviewShortcutBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Review shortcuts are global while the workspace is mounted. Let focused
  // controls retain their own keyboard handling, including screen-reader and
  // disclosure controls which are not text inputs.
  return Boolean(target.closest(
    "input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable='false']), " +
    "[role='button'], [role='link'], [role='textbox'], [role='combobox'], [role='menuitem'], " +
    "[role='option'], [role='tab'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider']",
  ));
}
