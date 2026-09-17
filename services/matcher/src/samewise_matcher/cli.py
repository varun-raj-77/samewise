import argparse
import json
import time
import tracemalloc
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError

from samewise_matcher.baseline import match_csvs, profile_csv, read_csv
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    CandidateGenerationResult,
    generate_candidates,
)
from samewise_matcher.candidate_evaluation import (
    evaluate_candidates,
    load_provenance,
    load_truth_pairs,
    markdown_summary,
)
from samewise_matcher.candidate_falsification import (
    markdown_falsification_summary,
    run_falsification,
)
from samewise_matcher.contracts import create_health_response
from samewise_matcher.evaluation_product import (
    compare_snapshots,
    load_weak_identifier_evidence,
    markdown_comparison,
    run_evaluation_product,
    write_evaluation_artifacts,
)
from samewise_matcher.explainable_matcher import MatcherConfig, match_csvs_explainable
from samewise_matcher.fixture_generator import generate_fixture, summarize_fixture
from samewise_matcher.fixture_models import CorruptionConfig, FixtureConfig
from samewise_matcher.matcher_evaluation import (
    markdown_matcher_report,
    run_fixture_evaluation,
)
from samewise_matcher.performance_benchmark import benchmark_fixture
from samewise_matcher.performance_benchmark import (
    markdown_summary as markdown_performance_summary,
)
from samewise_matcher.weak_identifier_fixture import (
    WeakIdentifierFixtureConfig,
    generate_weak_identifier_fixture,
)
from samewise_matcher.workflow_models import ManualMapping, MatchRequest, ProfileRequest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="samewise-matcher")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("health", help="emit matcher health as JSON")
    subcommands.add_parser(
        "process", help="read one validated profile or match request from stdin"
    )
    fixtures = subcommands.add_parser(
        "fixtures", help="generate or inspect deterministic benchmark fixtures"
    )
    fixture_commands = fixtures.add_subparsers(dest="fixture_command", required=True)
    generate = fixture_commands.add_parser("generate", help="generate a fixture")
    generate.add_argument("--fixture", required=True, help="versioned fixture name")
    generate.add_argument("--seed", required=True, type=int)
    generate.add_argument("--entities", required=True, type=int)
    generate.add_argument("--overlap-rate", type=float, default=0.70)
    generate.add_argument("--a-only-rate", type=float, default=0.15)
    generate.add_argument("--b-only-rate", type=float, default=0.15)
    generate.add_argument("--duplicate-rows-a", type=int, default=2)
    generate.add_argument("--duplicate-rows-b", type=int, default=2)
    generate.add_argument("--hard-negative-pairs", type=int, default=3)
    generate.add_argument(
        "--corruption-profile", choices=("low", "moderate", "high"), default="moderate"
    )
    generate.add_argument(
        "--output-root",
        type=Path,
        default=Path.cwd(),
        help="repository-shaped output root",
    )
    generate_config = fixture_commands.add_parser(
        "generate-config", help="generate a fixture from a committed JSON config"
    )
    generate_config.add_argument("--config", required=True, type=Path)
    generate_config.add_argument("--output-root", type=Path, default=Path.cwd())
    generate_weak = fixture_commands.add_parser(
        "generate-weak-config",
        help="generate a versioned weak-identifier adversarial fixture",
    )
    generate_weak.add_argument("--config", required=True, type=Path)
    generate_weak.add_argument("--output-root", type=Path, default=Path.cwd())
    summarize = fixture_commands.add_parser("summarize", help="print fixture facts")
    summarize.add_argument("--fixture", required=True)
    summarize.add_argument("--output-root", type=Path, default=Path.cwd())

    candidates = subcommands.add_parser(
        "candidates", help="generate or evaluate truth-blind candidate pairs"
    )
    candidate_commands = candidates.add_subparsers(
        dest="candidate_command", required=True
    )
    candidate_generate = candidate_commands.add_parser(
        "generate", help="generate candidates from visible CSV files"
    )
    _add_candidate_inputs(candidate_generate)
    candidate_generate.add_argument("--output", required=True, type=Path)

    candidate_evaluate = candidate_commands.add_parser(
        "evaluate", help="evaluate an existing candidate file against hidden truth"
    )
    _add_candidate_inputs(candidate_evaluate, include_config=False)
    candidate_evaluate.add_argument("--candidates", required=True, type=Path)
    candidate_evaluate.add_argument("--truth", required=True, type=Path)
    candidate_evaluate.add_argument("--provenance", type=Path)
    candidate_evaluate.add_argument("--manifest", type=Path)
    candidate_evaluate.add_argument("--output-dir", required=True, type=Path)

    benchmark = candidate_commands.add_parser(
        "benchmark", help="generate then separately evaluate a repository fixture"
    )
    benchmark.add_argument("--root", type=Path, default=Path.cwd())
    benchmark.add_argument("--fixture", required=True)
    benchmark.add_argument("--mappings", required=True, type=Path)
    benchmark.add_argument("--config", type=Path)
    benchmark.add_argument("--output-dir", required=True, type=Path)
    benchmark.add_argument(
        "--no-tracemalloc",
        action="store_true",
        help="skip Python allocation tracing for a lower-overhead safety run",
    )
    falsify = candidate_commands.add_parser(
        "falsify", help="run blocker ablations and adversarial evaluation"
    )
    falsify.add_argument("--root", type=Path, default=Path.cwd())
    falsify.add_argument("--fixture", required=True)
    falsify.add_argument("--mappings", required=True, type=Path)
    falsify.add_argument("--config", required=True, type=Path)
    falsify.add_argument("--output-dir", required=True, type=Path)

    matcher = subcommands.add_parser(
        "matcher", help="tune or evaluate versioned matcher behavior"
    )
    matcher_commands = matcher.add_subparsers(dest="matcher_command", required=True)
    for name in ("tune", "evaluate"):
        command = matcher_commands.add_parser(name)
        command.add_argument("--root", type=Path, default=Path.cwd())
        command.add_argument("--fixture", required=True)
        command.add_argument("--mappings", required=True, type=Path)
        command.add_argument("--candidate-config", required=True, type=Path)
        command.add_argument("--matcher-config", required=True, type=Path)
        command.add_argument("--output-dir", required=True, type=Path)

    evaluation = subcommands.add_parser(
        "evaluation", help="create, compare, and inspect versioned evaluation snapshots"
    )
    evaluation_commands = evaluation.add_subparsers(
        dest="evaluation_command", required=True
    )
    evaluation_run = evaluation_commands.add_parser(
        "run", help="evaluate baseline and current matcher on one frozen fixture"
    )
    evaluation_run.add_argument("--root", type=Path, default=Path.cwd())
    evaluation_run.add_argument("--fixture", required=True)
    evaluation_run.add_argument("--mappings", required=True, type=Path)
    evaluation_run.add_argument("--candidate-config", required=True, type=Path)
    evaluation_run.add_argument("--matcher-config", required=True, type=Path)
    evaluation_run.add_argument("--gates", required=True, type=Path)
    evaluation_run.add_argument("--output-dir", required=True, type=Path)
    evaluation_compare = evaluation_commands.add_parser(
        "compare", help="compare two compatible snapshot JSON files"
    )
    evaluation_compare.add_argument("--snapshot-a", required=True, type=Path)
    evaluation_compare.add_argument("--snapshot-b", required=True, type=Path)
    evaluation_compare.add_argument("--output-dir", required=True, type=Path)
    evaluation_errors = evaluation_commands.add_parser(
        "inspect-errors", help="print one filtered evaluation error set"
    )
    evaluation_errors.add_argument("--errors", required=True, type=Path)
    evaluation_errors.add_argument(
        "--type",
        choices=(
            "candidate_misses",
            "ranking_losses",
            "post_score_losses",
            "false_auto_matches",
            "false_unmatched",
            "hard_negatives",
        ),
    )
    performance = subcommands.add_parser(
        "performance", help="measure stage-level matcher performance"
    )
    performance_commands = performance.add_subparsers(
        dest="performance_command", required=True
    )
    performance_benchmark = performance_commands.add_parser(
        "benchmark", help="benchmark one deterministic repository fixture"
    )
    performance_benchmark.add_argument("--root", type=Path, default=Path.cwd())
    performance_benchmark.add_argument("--fixture", required=True)
    performance_benchmark.add_argument("--mappings", required=True, type=Path)
    performance_benchmark.add_argument(
        "--candidate-config", required=True, type=Path
    )
    performance_benchmark.add_argument("--matcher-config", required=True, type=Path)
    performance_benchmark.add_argument("--output-dir", required=True, type=Path)
    performance_benchmark.add_argument(
        "--no-tracemalloc",
        action="store_true",
        help="skip Python allocation tracing for a lower-overhead safety run",
    )
    return parser


def _add_candidate_inputs(
    parser: argparse.ArgumentParser, *, include_config: bool = True
) -> None:
    parser.add_argument("--a", required=True, type=Path)
    parser.add_argument("--b", required=True, type=Path)
    parser.add_argument("--mappings", required=True, type=Path)
    if include_config:
        parser.add_argument("--config", type=Path)


def _load_mappings(path: Path) -> list:
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload["mappings"] if isinstance(payload, dict) else payload
    return [ManualMapping.model_validate(value) for value in values]


def _load_candidate_config(path: Path | None) -> CandidateEngineConfig:
    if path is None:
        return CandidateEngineConfig()
    return CandidateEngineConfig.model_validate_json(path.read_text(encoding="utf-8"))


def _load_matcher_config(path: Path) -> MatcherConfig:
    return MatcherConfig.model_validate_json(path.read_text(encoding="utf-8"))


def _write_evaluation(
    output_dir: Path,
    candidates: CandidateGenerationResult,
    report: dict,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "candidates.json").write_text(
        candidates.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(markdown_summary(report), encoding="utf-8")
    (output_dir / "misses.json").write_text(
        json.dumps(report["missedTrueMatches"], indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _fixture_artifact(root: Path, manifest: dict, name: str) -> Path:
    return root / manifest["artifacts"][name]["path"]


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "health":
        health = create_health_response("matcher")
        print(json.dumps(health.model_dump(mode="json"), separators=(",", ":")))
        return 0

    if args.command == "process":
        try:
            import sys

            payload = json.load(sys.stdin)
            if payload.get("operation") == "profile":
                request = ProfileRequest.model_validate(payload)
                result = profile_csv(
                    Path(request.path),
                    request.datasetId,
                    request.side,
                    request.originalFilename,
                    request.sha256,
                )
            elif payload.get("operation") == "match":
                request = MatchRequest.model_validate(payload)
                if request.matcherVersion == "baseline-matcher-v0.1.0":
                    result = match_csvs(
                        Path(request.aPath),
                        Path(request.bPath),
                        request.mappings,
                        candidate_mode=request.candidateMode,
                    )
                else:
                    result = match_csvs_explainable(
                        Path(request.aPath),
                        Path(request.bPath),
                        request.mappings,
                        candidate_mode=request.candidateMode,
                    )
            else:
                raise ValueError("Unknown matcher operation")
            print(json.dumps(result.model_dump(mode="json"), separators=(",", ":")))
            return 0
        except (ValidationError, ValueError, OSError, json.JSONDecodeError) as error:
            print(
                json.dumps({"error": {"code": "invalid_input", "message": str(error)}})
            )
            return 2

    if args.command == "fixtures" and args.fixture_command == "generate":
        try:
            config = FixtureConfig(
                fixture_name=args.fixture,
                seed=args.seed,
                canonical_entity_count=args.entities,
                overlap_rate=args.overlap_rate,
                a_only_rate=args.a_only_rate,
                b_only_rate=args.b_only_rate,
                duplicate_rows_a=args.duplicate_rows_a,
                duplicate_rows_b=args.duplicate_rows_b,
                hard_negative_pairs=args.hard_negative_pairs,
                corruption=CorruptionConfig.preset(args.corruption_profile),
            )
        except ValidationError as error:
            print(f"Invalid fixture configuration:\n{error}")
            return 2
        manifest = generate_fixture(config, args.output_root)
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    if args.command == "fixtures" and args.fixture_command == "summarize":
        print(summarize_fixture(args.output_root, args.fixture), end="")
        return 0

    if args.command == "fixtures" and args.fixture_command == "generate-config":
        try:
            config = FixtureConfig.model_validate_json(
                args.config.read_text(encoding="utf-8")
            )
        except (ValidationError, OSError) as error:
            print(f"Invalid fixture configuration:\n{error}")
            return 2
        manifest = generate_fixture(config, args.output_root)
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    if args.command == "fixtures" and args.fixture_command == "generate-weak-config":
        try:
            config = WeakIdentifierFixtureConfig.model_validate_json(
                args.config.read_text(encoding="utf-8")
            )
        except (ValidationError, OSError) as error:
            print(f"Invalid weak-identifier fixture configuration:\n{error}")
            return 2
        manifest = generate_weak_identifier_fixture(config, args.output_root)
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    if args.command == "candidates" and args.candidate_command == "generate":
        mappings = _load_mappings(args.mappings)
        a_headers, a_rows = read_csv(args.a)
        b_headers, b_rows = read_csv(args.b)
        result = generate_candidates(
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            _load_candidate_config(args.config),
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            result.model_dump_json(indent=2) + "\n", encoding="utf-8"
        )
        print(f"Wrote {len(result.candidates)} candidates to {args.output}")
        return 0

    if args.command == "candidates" and args.candidate_command == "evaluate":
        mappings = _load_mappings(args.mappings)
        result = CandidateGenerationResult.model_validate_json(
            args.candidates.read_text(encoding="utf-8")
        )
        a_headers, a_rows = read_csv(args.a)
        b_headers, b_rows = read_csv(args.b)
        fixture = (
            json.loads(args.manifest.read_text(encoding="utf-8"))
            if args.manifest
            else {}
        )
        report = evaluate_candidates(
            result,
            load_truth_pairs(args.truth),
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            provenance=load_provenance(args.provenance),
            fixture=fixture,
        )
        _write_evaluation(args.output_dir, result, report)
        print(markdown_summary(report), end="")
        return 0

    if args.command == "candidates" and args.candidate_command == "benchmark":
        root = args.root.resolve()
        manifest_path = (
            root / "evaluation" / "benchmarks" / args.fixture / "manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        mappings = _load_mappings(args.mappings)
        a_path = _fixture_artifact(root, manifest, "dataset_a")
        b_path = _fixture_artifact(root, manifest, "dataset_b")
        a_headers, a_rows = read_csv(a_path)
        b_headers, b_rows = read_csv(b_path)
        if not args.no_tracemalloc:
            tracemalloc.start()
        started = time.perf_counter()
        result = generate_candidates(
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            _load_candidate_config(args.config),
        )
        elapsed = time.perf_counter() - started
        peak_memory = None
        if not args.no_tracemalloc:
            _, peak_memory = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        report = evaluate_candidates(
            result,
            load_truth_pairs(_fixture_artifact(root, manifest, "identity_truth")),
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            provenance=load_provenance(
                _fixture_artifact(root, manifest, "corruption_provenance")
            ),
            fixture=manifest,
            generation_runtime_seconds=round(elapsed, 6),
            peak_python_memory_bytes=peak_memory,
        )
        _write_evaluation(args.output_dir, result, report)
        print(markdown_summary(report), end="")
        return 0

    if args.command == "candidates" and args.candidate_command == "falsify":
        root = args.root.resolve()
        manifest_path = (
            root / "evaluation" / "benchmarks" / args.fixture / "manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        mappings = _load_mappings(args.mappings)
        a_headers, a_rows = read_csv(_fixture_artifact(root, manifest, "dataset_a"))
        b_headers, b_rows = read_csv(_fixture_artifact(root, manifest, "dataset_b"))
        truth_payload = json.loads(
            _fixture_artifact(root, manifest, "identity_truth").read_text(
                encoding="utf-8"
            )
        )
        hard_negative_payload = json.loads(
            _fixture_artifact(root, manifest, "hard_negatives").read_text(
                encoding="utf-8"
            )
        )
        report = run_falsification(
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            _load_candidate_config(args.config),
            truth_payload,
            hard_negative_payload,
            manifest,
            load_provenance(_fixture_artifact(root, manifest, "corruption_provenance")),
        )
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (args.output_dir / "summary.md").write_text(
            markdown_falsification_summary(report), encoding="utf-8"
        )
        (args.output_dir / "misses.json").write_text(
            json.dumps(report["missedTrueMatches"], indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(markdown_falsification_summary(report), end="")
        return 0

    if args.command == "matcher":
        phase = "tuning" if args.matcher_command == "tune" else "holdout"
        report, frozen = run_fixture_evaluation(
            args.root.resolve(),
            args.fixture,
            _load_mappings(args.mappings),
            _load_candidate_config(args.candidate_config),
            _load_matcher_config(args.matcher_config),
            phase=phase,
        )
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (args.output_dir / "summary.md").write_text(
            markdown_matcher_report(report), encoding="utf-8"
        )
        if frozen is not None:
            (args.output_dir / "frozen-matcher-config.json").write_text(
                frozen.model_dump_json(indent=2) + "\n", encoding="utf-8"
            )
        print(markdown_matcher_report(report), end="")
        return 0

    if args.command == "evaluation" and args.evaluation_command == "run":
        snapshots, errors, comparison = run_evaluation_product(
            args.root.resolve(),
            args.fixture,
            _load_mappings(args.mappings),
            _load_candidate_config(args.candidate_config),
            _load_matcher_config(args.matcher_config),
            json.loads(args.gates.read_text(encoding="utf-8")),
        )
        write_evaluation_artifacts(
            args.output_dir,
            snapshots,
            errors,
            comparison,
            [load_weak_identifier_evidence(args.root.resolve())],
        )
        print(markdown_comparison(comparison), end="")
        return 0

    if args.command == "evaluation" and args.evaluation_command == "compare":
        left = json.loads(args.snapshot_a.read_text(encoding="utf-8"))
        right = json.loads(args.snapshot_b.read_text(encoding="utf-8"))
        comparison = compare_snapshots(left, right)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "comparison.json").write_text(
            json.dumps(comparison, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (args.output_dir / "comparison.md").write_text(
            markdown_comparison(comparison), encoding="utf-8"
        )
        print(markdown_comparison(comparison), end="")
        return 0 if comparison["compatible"] else 3

    if args.command == "evaluation" and args.evaluation_command == "inspect-errors":
        errors = json.loads(args.errors.read_text(encoding="utf-8"))
        selected = (
            [error for error in errors if error["group"] == args.type]
            if args.type
            else errors
        )
        print(json.dumps(selected, indent=2, sort_keys=True))
        return 0

    if args.command == "performance" and args.performance_command == "benchmark":
        report = benchmark_fixture(
            args.root,
            args.fixture,
            _load_mappings(args.mappings),
            _load_candidate_config(args.candidate_config),
            _load_matcher_config(args.matcher_config),
            trace_python_memory=not args.no_tracemalloc,
        )
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "benchmark.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (args.output_dir / "summary.md").write_text(
            markdown_performance_summary(report), encoding="utf-8"
        )
        print(markdown_performance_summary(report), end="")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
