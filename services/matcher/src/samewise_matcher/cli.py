import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError

from samewise_matcher.baseline import match_csvs, profile_csv
from samewise_matcher.contracts import create_health_response
from samewise_matcher.fixture_generator import generate_fixture, summarize_fixture
from samewise_matcher.fixture_models import CorruptionConfig, FixtureConfig
from samewise_matcher.workflow_models import MatchRequest, ProfileRequest


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
    summarize = fixture_commands.add_parser("summarize", help="print fixture facts")
    summarize.add_argument("--fixture", required=True)
    summarize.add_argument("--output-root", type=Path, default=Path.cwd())
    return parser


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
                result = match_csvs(
                    Path(request.aPath), Path(request.bPath), request.mappings
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

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
