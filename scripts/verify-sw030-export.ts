import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { PortableExportVerificationError, verifyPortableExport } from "../apps/api/src/portable-export-verifier.js";

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length < 2 || paths.length > 3) {
    throw new PortableExportVerificationError(
      "usage",
      "Usage: pnpm verify:export -- <manifest.json> <reconciliation.csv> [trusted-merged.csv]",
    );
  }
  const [manifestPath, ...artifactPaths] = paths;
  const manifestText = await readFile(manifestPath, "utf8");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new PortableExportVerificationError("invalid_json", "Manifest is not valid JSON.");
  }
  const files = await Promise.all(artifactPaths.map(async (path) => ({
    filename: basename(path),
    bytes: await readFile(path),
  })));
  const result = verifyPortableExport(manifest, files);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((error: unknown) => {
  const code = error instanceof PortableExportVerificationError ? error.code : "verification_failed";
  const message = error instanceof PortableExportVerificationError ? error.message : "Could not read or verify the supplied export files.";
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exitCode = 1;
});
