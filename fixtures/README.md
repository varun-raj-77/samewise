# Fixtures

Test data is organized by intent. Fixtures must be synthetic or appropriately licensed, deterministic, and accompanied by explicit expected outcomes when applicable.

`corrupted/organizations/<version>/dataset_a.csv` and `dataset_b.csv` are the only product-visible fixture inputs. Canonical IDs and generation evidence are deliberately restricted to the canonical, adversarial, and ground-truth trees. The small `organizations-dev-v1` fixture includes exact-looking records, fuzzy names, missing cells, conflicting business values, hard negatives, source-only entities, and within-source duplicates.

Do not use hidden fixture artifacts as matcher inputs. They exist only to generate fixtures, test invariants, and evaluate future matcher output.
