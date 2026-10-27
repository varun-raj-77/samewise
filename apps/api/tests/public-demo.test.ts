import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConflictPageSchema, ReviewQueuePageSchema, RunManifestSchema, RunSummarySchema, type ManualMapping } from "@samewise/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createMatcherRunner } from "../src/matcher-process.js";
import { verifyPortableExport } from "../src/portable-export-verifier.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.platform === "win32"
  ? join(root, "services/matcher/.venv/Scripts/python.exe")
  : join(root, "services/matcher/.venv/bin/python");
const sampleRoot = join(root, "apps/web/public/samples");
const sampleAPath = join(sampleRoot, "samewise_sample_vendors_a.csv");
const sampleBPath = join(sampleRoot, "samewise_sample_vendors_b.csv");

const mappings: ManualMapping[] = [
  { mappingId: "source-record-id", label: "Source record ID", aColumn: "source_record_id", bColumn: "source_record_id", useForMatching: false, includeInMerge: false, normalizer: "text", semanticFamily: "source_local_identifier" },
  { mappingId: "stable-id", label: "Stable ID", aColumn: "stable_id", bColumn: "stable_id", useForMatching: true, includeInMerge: false, normalizer: "text", semanticFamily: "persistent_identifier" },
  { mappingId: "company-name", label: "Company name", aColumn: "company_name", bColumn: "company_name", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "name_or_title" },
  { mappingId: "address", label: "Address", aColumn: "address", bColumn: "address", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "address" },
  { mappingId: "city", label: "City", aColumn: "city", bColumn: "city", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "geography" },
  { mappingId: "region", label: "Region", aColumn: "region", bColumn: "region", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "geography" },
  { mappingId: "postal", label: "Postal", aColumn: "postal", bColumn: "postal", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "geography" },
  { mappingId: "email", label: "Email", aColumn: "email", bColumn: "email", useForMatching: true, includeInMerge: true, normalizer: "email", semanticFamily: "email" },
  { mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", useForMatching: true, includeInMerge: true, normalizer: "phone", semanticFamily: "phone" },
  { mappingId: "contact-name", label: "Contact name", aColumn: "contact_name", bColumn: "contact_name", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "contact_person" },
  { mappingId: "updated-at", label: "Updated at", aColumn: "updated_at", bColumn: "updated_at", useForMatching: false, includeInMerge: true, normalizer: "date", semanticFamily: "date_or_timestamp" },
];

describe.skipIf(!existsSync(python))("public demo fixture with the frozen matcher", () => {
  let previousPython: string | undefined;
  let previousDirectory: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    previousPython = process.env.SAMEWISE_PYTHON;
    previousDirectory = process.cwd();
    process.chdir(root);
    process.env.SAMEWISE_PYTHON = python;
    app = buildApp({ dataRoot: await mkdtemp(join(tmpdir(), "samewise-public-demo-")), matcher: createMatcherRunner() });
  });

  afterEach(async () => {
    await app.close();
    process.chdir(previousDirectory);
    if (previousPython === undefined) delete process.env.SAMEWISE_PYTHON;
    else process.env.SAMEWISE_PYTHON = previousPython;
  });

  it("keeps downloadable bytes intact and demonstrates match, review, source-only, merge, and trusted-export states", async () => {
    const bytesA = await readFile(sampleAPath);
    const bytesB = await readFile(sampleBPath);
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, filename, bytes] of [["A", "samewise_sample_vendors_a.csv", bytesA], ["B", "samewise_sample_vendors_b.csv", bytesB]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": filename }, payload: bytes });
      expect(response.statusCode).toBe(201);
      const uploaded = RunSummarySchema.parse(response.json());
      expect(uploaded.datasets[side]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(uploaded.datasets[side]?.rowCount).toBe(28);
    }

    const mapped = await app.inject({ method: "PUT", url: `/api/runs/${created.runId}/mappings`, payload: { mappings } });
    expect(mapped.statusCode).toBe(200);
    const matched = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${created.runId}/match` })).json());
    // These small counts are the intended public tour shape. A changed matcher or
    // fixture should be reviewed deliberately rather than silently changing it.
    expect(matched.summary).toEqual({ matched: 23, needsReview: 1, onlyA: 4, onlyB: 4 });

    const review = ReviewQueuePageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${created.runId}/review?filter=unresolved&limit=100` })).json());
    expect(review.items.length).toBeGreaterThanOrEqual(1);
    expect(review.items.length).toBeLessThanOrEqual(3);
    expect(review.items[0]).toMatchObject({ aRowId: "A-1024", topBRowId: "B-2024" });
    for (const item of review.items) {
      const decision = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/candidates/${item.topCandidateId}/decisions`, payload: { decision: "same_entity" } });
      expect(decision.statusCode).toBe(200);
    }

    let afterReview = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${created.runId}` })).json());
    expect(afterReview.reviewProgress.remaining).toBe(0);
    expect(afterReview.conflictSummary.total).toBeGreaterThan(0);
    const conflicts = ConflictPageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${created.runId}/conflicts?limit=100` })).json());
    expect(conflicts.items.length).toBeGreaterThan(0);
    for (const conflict of conflicts.items) {
      const resolution = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/conflicts/${conflict.conflictId}/resolutions`, payload: { action: "use_a" } });
      expect(resolution.statusCode).toBe(200);
    }
    afterReview = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${created.runId}` })).json());
    expect(afterReview.trustedExportReadiness.ready).toBe(true);
    // Recreate all three real exported artifacts from one immutable source+decision snapshot.
    const baseUrl = `/api/runs/${created.runId}`;
    const manifestResponse = await app.inject({ method: "GET", url: `${baseUrl}/manifest` });
    expect(manifestResponse.statusCode).toBe(200);
    const snapshotPin = manifestResponse.headers["x-samewise-export-snapshot"];
    expect(snapshotPin).toMatch(/^[a-f0-9]{64}$/);
    if (typeof snapshotPin !== "string") throw new Error("Missing export snapshot pin.");
    const manifest = RunManifestSchema.parse(manifestResponse.json());
    expect(manifest.run.snapshot.authoritativeStateSha256).toBe(snapshotPin);
    expect(manifest.run.status).toBe("trusted_ready");
    expect(manifest.identity.humanSameCount).toBeGreaterThanOrEqual(1);
    expect(manifest.survivorship.unresolvedConflictCount).toBe(0);
    expect(manifest.sourceDatasets.A.sha256).toBe(createHash("sha256").update(bytesA).digest("hex"));
    expect(manifest.sourceDatasets.B.sha256).toBe(createHash("sha256").update(bytesB).digest("hex"));

    const reportResponse = await app.inject({ method: "GET", url: `${baseUrl}/export?expectedSnapshot=${snapshotPin}` });
    const trustedResponse = await app.inject({ method: "GET", url: `${baseUrl}/trusted-export?expectedSnapshot=${snapshotPin}` });
    for (const response of [reportResponse, trustedResponse]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-samewise-export-snapshot"]).toBe(snapshotPin);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const filename = (response: typeof reportResponse) => {
      const disposition = response.headers["content-disposition"];
      const matched = typeof disposition === "string" ? /filename="([A-Za-z0-9._-]+)"/.exec(disposition) : null;
      if (!matched?.[1]) throw new Error("Export did not provide a canonical filename.");
      return matched[1];
    };
    const verified = verifyPortableExport(manifest, [
      { filename: filename(reportResponse), bytes: Buffer.from(reportResponse.body, "utf8") },
      { filename: filename(trustedResponse), bytes: Buffer.from(trustedResponse.body, "utf8") },
    ]);
    expect(verified.status).toBe("trusted_ready");
    expect(verified.verified.map((item) => item.kind)).toEqual(["reconciliation_report", "trusted_merged_output"]);

    // A later resolution edit must invalidate the old pin for every export endpoint.
    const changed = await app.inject({
      method: "POST",
      url: `${baseUrl}/conflicts/${conflicts.items[0]!.conflictId}/resolutions`,
      payload: { action: "use_b", replace: true },
    });
    expect(changed.statusCode).toBe(200);
    for (const endpoint of ["export", "trusted-export", "manifest"]) {
      const stale = await app.inject({ method: "GET", url: `${baseUrl}/${endpoint}?expectedSnapshot=${snapshotPin}` });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: "stale_export_snapshot" } });
    }
  }, 30_000);
});
