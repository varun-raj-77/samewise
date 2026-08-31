# Samewise matcher

This uv-managed Python package is the process boundary for profiling and the intentionally naive SW-003 baseline matcher. It also contains the health command and deterministic evaluation-fixture tooling.

```text
uv sync --project services/matcher --locked
uv run --project services/matcher samewise-matcher health
```

`samewise-matcher process` accepts one versioned JSON profile or match request on stdin and returns JSON on stdout. The baseline performs explicit O(N×M) comparison for small development fixtures only. Its scores are inspectable, deterministic, and uncalibrated; comparison/survivorship mappings do not affect identity scores.

Generate and inspect a versioned organization fixture:

```text
uv run --project services/matcher samewise-matcher fixtures generate --seed 42 --entities 24 --fixture organizations-dev-v1
uv run --project services/matcher samewise-matcher fixtures summarize --fixture organizations-dev-v1
```

Use `--output-root` to write the same repository-shaped artifact tree beneath a temporary directory. The generator does not use wall-clock time; its files are stable for the same generator version, validated configuration, and seed.
