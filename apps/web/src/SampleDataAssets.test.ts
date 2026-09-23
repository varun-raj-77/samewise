import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public/samples");
const paths = [
  join(sampleRoot, "samewise_sample_vendors_a.csv"),
  join(sampleRoot, "samewise_sample_vendors_b.csv"),
];
const forbiddenHeaders = new Set(["true_match_id", "ground_truth_id", "expected_decision", "canonical_pair_id"]);

function rows(csv: string): string[][] {
  return csv.trim().split(/\r?\n/).map((line) => line.split(","));
}

describe("public sample CSV assets", () => {
  it("ships two valid, small, UTF-8 source-only CSV files", async () => {
    for (const path of paths) {
      const bytes = await readFile(path);
      const csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = rows(csv);
      const header = parsed[0] ?? [];
      expect((await stat(path)).size).toBeLessThan(2 * 1024 * 1024);
      expect(parsed).toHaveLength(29);
      expect(header).toEqual(["source_record_id", "stable_id", "company_name", "address", "city", "region", "postal", "email", "phone", "contact_name", "updated_at"]);
      expect(header.some((name) => forbiddenHeaders.has(name))).toBe(false);
      expect(parsed.slice(1).every((row) => row.length === header.length)).toBe(true);
    }
  });

  it("contains only visibly synthetic safe values and no spreadsheet formulas", async () => {
    for (const path of paths) {
      const parsed = rows(await readFile(path, "utf8"));
      const header = parsed[0] ?? [];
      const emailIndex = header.indexOf("email");
      const phoneIndex = header.indexOf("phone");
      for (const row of parsed.slice(1)) {
        expect(row.every((cell) => !/^[=+\-@]/.test(cell))).toBe(true);
        expect(row[emailIndex] === "" || /^[a-z0-9.]+@[a-z0-9.-]+\.example\.com$/.test(row[emailIndex] ?? "")).toBe(true);
        expect(row[phoneIndex]?.replaceAll(/\D/g, "")).toMatch(/^20255501\d{2}$/);
      }
    }
  });
});
