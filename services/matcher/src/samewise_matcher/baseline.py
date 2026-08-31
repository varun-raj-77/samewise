import csv
import re
import unicodedata
from datetime import datetime
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from pathlib import Path

from samewise_matcher.workflow_models import (
    MATCHER_VERSION,
    WORKFLOW_CONTRACT_VERSION,
    CandidatePair,
    ColumnProfile,
    DatasetProfile,
    FieldEvidence,
    ManualMapping,
    MatcherResult,
)

HIGH_SCORE_THRESHOLD = 0.82
REVIEW_SCORE_THRESHOLD = 0.38
HIGH_MARGIN_THRESHOLD = 0.08
ALTERNATIVE_FLOOR = 0.30
MAX_ALTERNATIVES = 3


class CsvInputError(ValueError):
    """Safe, user-facing CSV input failure."""


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle, strict=True)
            headers = reader.fieldnames
            if not headers or any(not header.strip() for header in headers):
                raise CsvInputError("CSV must contain a non-empty header row")
            if len(set(headers)) != len(headers):
                raise CsvInputError("CSV column names must be unique")
            rows: list[dict[str, str]] = []
            for row in reader:
                if None in row:
                    raise CsvInputError("CSV row has more values than the header")
                rows.append({header: (row.get(header) or "") for header in headers})
    except UnicodeDecodeError as error:
        raise CsvInputError("CSV must use UTF-8 encoding") from error
    except csv.Error as error:
        raise CsvInputError("CSV could not be parsed") from error
    return headers, rows


def _is_integer(value: str) -> bool:
    return bool(re.fullmatch(r"[+-]?\d+", value.strip()))


def _is_number(value: str) -> bool:
    try:
        Decimal(value.strip())
        return True
    except InvalidOperation:
        return False


def _is_boolean(value: str) -> bool:
    return value.strip().casefold() in {"true", "false", "yes", "no"}


def _is_date(value: str) -> bool:
    try:
        datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def infer_type(values: list[str]) -> str:
    populated = [value for value in values if value.strip()]
    if not populated:
        return "unknown"
    checks = (
        ("integer", _is_integer),
        ("number", _is_number),
        ("boolean", _is_boolean),
        ("date", _is_date),
    )
    for name, check in checks:
        if all(check(value) for value in populated):
            return name
    return "string"


def profile_csv(
    path: Path, dataset_id: str, side: str, original_filename: str, sha256: str
) -> DatasetProfile:
    headers, rows = read_csv(path)
    count = len(rows)
    profiles: list[ColumnProfile] = []
    for header in headers:
        values = [row[header] for row in rows]
        populated = [value for value in values if value.strip()]
        samples = list(dict.fromkeys(populated))[:3]
        distinct = len(set(populated))
        null_count = count - len(populated)
        profiles.append(
            ColumnProfile(
                name=header,
                inferredType=infer_type(values),
                nullCount=null_count,
                nullRate=round(null_count / count, 6) if count else 0,
                distinctCount=distinct,
                distinctRate=round(distinct / count, 6) if count else 0,
                samples=samples,
            )
        )
    return DatasetProfile(
        contractVersion=WORKFLOW_CONTRACT_VERSION,
        datasetId=dataset_id,
        side=side,
        originalFilename=original_filename,
        sha256=sha256,
        rowCount=count,
        columns=profiles,
    )


def normalize(value: str, kind: str) -> str:
    value = unicodedata.normalize("NFKC", value).strip().casefold()
    if not value:
        return ""
    if kind == "phone":
        digits = re.sub(r"\D", "", value)
        return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits
    if kind == "email":
        return re.sub(r"\s+", "", value)
    if kind == "number":
        try:
            return format(Decimal(value.replace(",", "")).normalize(), "f")
        except InvalidOperation:
            return value
    if kind == "date":
        try:
            return datetime.fromisoformat(value.replace("z", "+00:00")).isoformat()
        except ValueError:
            return value
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def compare_field(mapping: ManualMapping, a_value: str, b_value: str) -> FieldEvidence:
    a_normalized = normalize(a_value, mapping.normalizer)
    b_normalized = normalize(b_value, mapping.normalizer)
    if not a_normalized and not b_normalized:
        outcome, contribution = "missing_both", 0.0
        explanation = (
            "Both mapped values are missing; this field adds no identity evidence."
        )
    elif not a_normalized or not b_normalized:
        outcome, contribution = "missing_one", 0.0
        explanation = (
            "One mapped value is missing; this field adds no identity evidence."
        )
    elif a_normalized == b_normalized:
        outcome, contribution = "exact", 1.0
        explanation = f"Values are equal after {mapping.normalizer} normalization."
    elif mapping.normalizer == "text":
        similarity = SequenceMatcher(
            None, a_normalized, b_normalized, autojunk=False
        ).ratio()
        if similarity >= 0.65:
            outcome, contribution = "similar", round(similarity, 6)
            explanation = "Normalized text similarity is the displayed contribution."
        else:
            outcome, contribution = "conflict", 0.0
            explanation = "Normalized text differs below the 0.65 similarity floor."
    else:
        outcome, contribution = "conflict", 0.0
        explanation = f"Values differ after {mapping.normalizer} normalization."
    return FieldEvidence(
        mappingId=mapping.mappingId,
        label=mapping.label,
        aColumn=mapping.aColumn,
        bColumn=mapping.bColumn,
        aValue=a_value,
        bValue=b_value,
        normalizedA=a_normalized,
        normalizedB=b_normalized,
        outcome=outcome,
        contribution=contribution,
        explanation=explanation,
    )


def _row_id(row: dict[str, str], headers: list[str], side: str, index: int) -> str:
    first_value = row.get(headers[0], "").strip()
    return first_value or f"{side}-{index + 1}"


def match_csvs(
    a_path: Path, b_path: Path, mappings: list[ManualMapping]
) -> MatcherResult:
    a_headers, a_rows = read_csv(a_path)
    b_headers, b_rows = read_csv(b_path)
    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    if not identity:
        raise ValueError("At least one identity mapping is required")
    for mapping in mappings:
        if mapping.aColumn not in a_headers or mapping.bColumn not in b_headers:
            raise ValueError("A mapping references a column that does not exist")

    ranked_by_a: list[list[tuple[float, int, list[FieldEvidence]]]] = []
    preferred_b_counts: dict[int, int] = {}
    for a_row in a_rows:
        ranked: list[tuple[float, int, list[FieldEvidence]]] = []
        for b_index, b_row in enumerate(b_rows):
            evidence = [
                compare_field(mapping, a_row[mapping.aColumn], b_row[mapping.bColumn])
                for mapping in identity
            ]
            score = round(
                sum(item.contribution for item in evidence) / len(identity), 6
            )
            ranked.append((score, b_index, evidence))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        ranked_by_a.append(ranked)
        if ranked and ranked[0][0] >= REVIEW_SCORE_THRESHOLD:
            preferred_b_counts[ranked[0][1]] = (
                preferred_b_counts.get(ranked[0][1], 0) + 1
            )

    candidates: list[CandidatePair] = []
    only_a: list[dict[str, object]] = []
    proposed_b: set[int] = set()
    for a_index, (a_row, ranked) in enumerate(zip(a_rows, ranked_by_a, strict=True)):
        a_row_id = _row_id(a_row, a_headers, "A", a_index)
        if not ranked or ranked[0][0] < REVIEW_SCORE_THRESHOLD:
            only_a.append({"rowId": a_row_id, "record": a_row})
            continue
        top_score, top_b_index, _ = ranked[0]
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        margin = round(max(0.0, top_score - runner_up), 6)
        collision = preferred_b_counts.get(top_b_index, 0) > 1
        proposed = (
            top_score >= HIGH_SCORE_THRESHOLD
            and margin >= HIGH_MARGIN_THRESHOLD
            and not collision
        )
        alternative_cutoff = max(ALTERNATIVE_FLOOR, top_score - 0.25)
        alternatives = [item for item in ranked if item[0] >= alternative_cutoff][
            :MAX_ALTERNATIVES
        ]
        for rank, (score, b_index, evidence) in enumerate(alternatives, start=1):
            b_row = b_rows[b_index]
            b_row_id = _row_id(b_row, b_headers, "B", b_index)
            if rank == 1 and proposed:
                proposed_b.add(b_index)
            candidates.append(
                CandidatePair(
                    candidateId=f"candidate-{a_index + 1}-{b_index + 1}",
                    aRowId=a_row_id,
                    bRowId=b_row_id,
                    aRecord=a_row,
                    bRecord=b_row,
                    rank=rank,
                    baselineScore=score,
                    runnerUpMargin=margin if rank == 1 else 0,
                    band="proposed_match" if rank == 1 and proposed else "needs_review",
                    collision=collision if rank == 1 else False,
                    evidence=evidence,
                )
            )

    only_b = [
        {"rowId": _row_id(row, b_headers, "B", index), "record": row}
        for index, row in enumerate(b_rows)
        if index not in proposed_b
    ]
    return MatcherResult(
        contractVersion=WORKFLOW_CONTRACT_VERSION,
        matcherVersion=MATCHER_VERSION,
        candidates=candidates,
        onlyA=only_a,
        onlyB=only_b,
    )
