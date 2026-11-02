# SW-034 — Local browser export integrity check

## User problem

The existing SW-030 portable verifier requires Node/pnpm and a command line. People
working in Samewise need to confirm that their downloaded CSVs are intact without
installing development tools or sending potentially sensitive datasets to another service.

## Scope

- Reusable, opt-in `Verify downloaded files on this device` panel on the upload
  and export screens. It can check saved files from any run.
- User picks a provenance manifest and reconciliation report, plus the trusted
  merged CSV if the manifest declares one. No source dataset uploads are needed.
- Checks the versioned manifest schema; artifact kinds, versions and filenames;
  trusted readiness consistency; the evidence-plan digest; raw-byte lengths and
  SHA-256 hashes. File order is irrelevant. Any missing/extra/renamed artifact fails.
- Entire file verification runs in the user's browser through Web Crypto. This
  action does not call the API, mutate workflow state or print CSV contents.
- Results clear when inputs change, errors never include row contents, and 5 MiB
  manifests / 64 MiB CSVs are explicit browser resource limits.

## Safety

Passing means **consistency with this supplied manifest**, not proof of
publisher authenticity, correct matches, independent replay, actual human review
or a verified authoritative server state. Anyone replacing the manifest and
CSVs together can recompute the unkeyed hashes. No digital signatures are added.

Browser verification mirrors `apps/api/src/portable-export-verifier.ts`.
That established offline CLI remains available for automated and larger-file use.
The two implementations must be kept in parity whenever the manifest format
or portable-verification rules change.

## Excluded

No backend, signing, storage, production test, manual deployment, infrastructure,
matcher thresholds, run-state changes, pricing, or fabricated matching metrics.
