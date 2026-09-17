# Scenario fixture contract

Each directory is independently executable and intentionally small. Visible input
files contain source row IDs and business fields only. Expected identity links and
source-only rows live beneath `truth/` and are loaded only after candidate generation
and scoring.

`scenario.json` describes the adversarial question and declared fields whose raw
values should be inspected after identity. It contains no row-pair labels.

The shared `../../mappings.json` uses eight identity fields and two comparison
fields. That choice deliberately exposes a current product constraint: a field
mapped as identity evidence is not also survivorship-controlled. The validator
reports raw declared conflicts separately from product comparison-field conflicts.

Do not add `canonical_id`, `entity_id`, `expected_match`, `is_match`, or `truth`
columns to the product inputs. `validate.py` rejects them.
