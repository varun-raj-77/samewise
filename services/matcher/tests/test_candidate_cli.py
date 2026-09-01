import json
from pathlib import Path

from samewise_matcher.cli import main


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def test_candidate_generate_and_evaluate_are_separate_cli_phases(
    tmp_path: Path,
) -> None:
    a_path = tmp_path / "a.csv"
    b_path = tmp_path / "b.csv"
    mappings_path = tmp_path / "mappings.json"
    truth_path = tmp_path / "identity_truth.json"
    candidates_path = tmp_path / "candidates.json"
    report_dir = tmp_path / "report"
    a_path.write_text("id,phone\nA1,5550101000\n", encoding="utf-8")
    b_path.write_text("id,telephone\nB1,+1 555 010 1000\n", encoding="utf-8")
    write_json(
        mappings_path,
        {
            "mappings": [
                {
                    "mappingId": "phone",
                    "label": "Phone",
                    "aColumn": "phone",
                    "bColumn": "telephone",
                    "role": "identity",
                    "normalizer": "phone",
                }
            ]
        },
    )
    write_json(
        truth_path,
        {
            "truth_format_version": "1.0.0",
            "source_a": [
                {
                    "source_row_id": "A1",
                    "canonical_entity_id": "hidden-1",
                    "occurrence": "primary",
                }
            ],
            "source_b": [
                {
                    "source_row_id": "B1",
                    "canonical_entity_id": "hidden-1",
                    "occurrence": "primary",
                }
            ],
        },
    )

    assert (
        main(
            [
                "candidates",
                "generate",
                "--a",
                str(a_path),
                "--b",
                str(b_path),
                "--mappings",
                str(mappings_path),
                "--output",
                str(candidates_path),
            ]
        )
        == 0
    )
    generated = json.loads(candidates_path.read_text(encoding="utf-8"))
    assert generated["candidates"][0]["aRowId"] == "A1"
    assert "canonical" not in candidates_path.read_text(encoding="utf-8")

    assert (
        main(
            [
                "candidates",
                "evaluate",
                "--a",
                str(a_path),
                "--b",
                str(b_path),
                "--mappings",
                str(mappings_path),
                "--candidates",
                str(candidates_path),
                "--truth",
                str(truth_path),
                "--output-dir",
                str(report_dir),
            ]
        )
        == 0
    )
    report = json.loads((report_dir / "report.json").read_text(encoding="utf-8"))
    assert report["metrics"]["candidateRecall"] == 1
    assert (report_dir / "misses.json").read_text(encoding="utf-8").strip() == "[]"
