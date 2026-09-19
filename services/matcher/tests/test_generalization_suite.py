from samewise_matcher.generalization_suite import run_generalization_suite


def test_cross_domain_gates_and_low_information_abstention() -> None:
    report = run_generalization_suite()
    assert report["thresholdChanges"] == "none"
    assert report["passed"], report
    by_fixture = {item["fixture"]: item for item in report["results"]}
    assert set(by_fixture) == {
        "organizations_vendors",
        "people_customers",
        "products",
        "facilities",
        "sparse_legacy",
        "low_information",
    }
    assert by_fixture["products"]["candidateRecall"] >= 0.95
    assert by_fixture["facilities"]["candidateRecall"] >= 0.95
    assert by_fixture["low_information"]["autoMatchCount"] == 0
    assert by_fixture["low_information"]["weakEvidenceAbstention"]
