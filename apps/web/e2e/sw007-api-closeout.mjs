import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const api = "http://127.0.0.1:3000/api";
const fixtureRoot = resolve(root, "fixtures/corrupted/organizations/organizations-dev-v1");
const sourceA = join(fixtureRoot, "dataset_a.csv");
const sourceB = join(fixtureRoot, "dataset_b.csv");
const artifactRoot = resolve(root, "evaluation/reports/sw-007/integration");
await mkdir(artifactRoot, { recursive: true });

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const before = [await digest(sourceA), await digest(sourceB)];
const request = async (path, init = {}) => {
  const response = await fetch(`${api}${path}`, init);
  const payload = await response.json();
  assert(response.ok, `${init.method ?? "GET"} ${path}: ${JSON.stringify(payload)}`);
  return payload;
};

const mappingRows = [
  ["Organization", "vendor_name", "organization", "identity", "text"],
  ["Phone", "phone", "telephone", "identity", "phone"],
  ["Email", "contact_email", "email_address", "identity", "email"],
  ["Street", "street", "address_line_1", "identity", "text"],
  ["City", "city", "locality", "identity", "text"],
  ["State", "state", "region", "identity", "text"],
  ["Postal code", "zip", "postal_code", "identity", "text"],
  ["Website", "website", "domain", "identity", "text"],
  ["Status", "account_status", "status", "comparison", "text"],
  ["Balance", "balance", "outstanding_balance", "comparison", "number"],
  ["Updated at", "updated_at", "last_updated", "comparison", "date"],
];
const mappings = mappingRows.map(([label, aColumn, bColumn, role, normalizer], index) => ({
  mappingId: `walkthrough-${index}`, label, aColumn, bColumn, role, normalizer,
}));

const created = await request("/runs", { method: "POST" });
const runId = created.runId;
for (const [side, path] of [["A", sourceA], ["B", sourceB]]) {
  await request(`/runs/${runId}/datasets/${side}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv", "X-File-Name": `dataset_${side.toLowerCase()}.csv` },
    body: await readFile(path),
  });
}
await request(`/runs/${runId}/mappings`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings }),
});
const matched = await request(`/runs/${runId}/match`, { method: "POST" });

const ambiguous = matched.reviewQueue.find((item) => {
  if (item.state !== "needs_review" || item.candidateCount < 2) return false;
  const candidate = matched.candidates.find((entry) => entry.candidateId === item.topCandidateId);
  return mappings.filter((mapping) => mapping.role === "comparison")
    .some((mapping) => candidate.aRecord[mapping.aColumn] !== candidate.bRecord[mapping.bColumn]);
});
assert(ambiguous, "Expected an ambiguous review item with an alternate and comparison conflict.");
const sameCandidate = matched.candidates.find((candidate) => candidate.candidateId === ambiguous.topCandidateId);
const otherItems = matched.reviewQueue.filter((item) => item.state === "needs_review" && item.aRowId !== ambiguous.aRowId);
assert(otherItems.length >= 2, "Expected additional review items for DIFFERENT and DEFER.");
const [deferItem, differentItem] = otherItems;
const differentCandidate = matched.candidates.find((candidate) => candidate.candidateId === differentItem.topCandidateId);

const deferred = await request(`/runs/${runId}/review-items/${encodeURIComponent(deferItem.aRowId)}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deferred: true }),
});
const returned = await request(`/runs/${runId}/review-items/${encodeURIComponent(deferItem.aRowId)}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deferred: false }),
});
const same = await request(`/runs/${runId}/candidates/${sameCandidate.candidateId}/decisions`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "same_entity" }),
});
const sameConflicts = same.conflicts.filter((conflict) => conflict.candidateId === sameCandidate.candidateId);
const undone = await request(`/runs/${runId}/review-undo`, { method: "POST" });
await request(`/runs/${runId}/candidates/${sameCandidate.candidateId}/decisions`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "same_entity" }),
});
const different = await request(`/runs/${runId}/candidates/${differentCandidate.candidateId}/decisions`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "different_entity" }),
});
await request(`/runs/${runId}/review-items/${encodeURIComponent(deferItem.aRowId)}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deferred: true }),
});
const refreshed = await request(`/runs/${runId}`);
const after = [await digest(sourceA), await digest(sourceB)];

const report = {
  status: "PASS",
  fixture: "organizations-dev-v1",
  runId,
  recoveryRoute: `http://localhost:5173/?run=${runId}&screen=review`,
  initialSummary: matched.summary,
  initialProgress: matched.reviewProgress,
  matcher: matched.matcherProvenance.matcherVersion,
  candidateEngine: matched.matcherProvenance.candidateEngineVersion,
  ambiguous: {
    aRowId: ambiguous.aRowId,
    candidateCount: ambiguous.candidateCount,
    topBRowId: ambiguous.topBRowId,
    alternateBRowId: matched.candidates.find((candidate) => candidate.aRowId === ambiguous.aRowId && candidate.rank === 2)?.bRowId,
  },
  checks: {
    deferRoundTrip: deferred.reviewProgress.deferred === 1 && returned.reviewProgress.deferred === 0,
    sameDecisionStored: same.decisions.some((decision) => decision.candidateId === sameCandidate.candidateId && decision.humanDecision === "same_entity"),
    sameCreatedConflicts: sameConflicts.length > 0,
    sameAutomaticResolutionCount: sameConflicts.filter((conflict) => conflict.resolution).length,
    undoRemovedDecision: !undone.decisions.some((decision) => decision.candidateId === sameCandidate.candidateId),
    undoRemovedCreatedConflicts: !undone.conflicts.some((conflict) => conflict.candidateId === sameCandidate.candidateId),
    differentCreatedConflictCount: different.conflicts.filter((conflict) => conflict.candidateId === differentCandidate.candidateId).length,
    refreshRecovered: refreshed.runId === runId,
    sourceImmutable: JSON.stringify(before) === JSON.stringify(after),
  },
  finalProgress: refreshed.reviewProgress,
  sourceHashesBefore: before,
  sourceHashesAfter: after,
};
assert(Object.entries(report.checks).every(([name, value]) => name.endsWith("Count") ? value === 0 : value === true), JSON.stringify(report.checks));
await writeFile(join(artifactRoot, "sw007-api-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
