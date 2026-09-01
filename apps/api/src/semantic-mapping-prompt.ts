import { SEMANTIC_MAPPING_PROMPT_VERSION } from "@samewise/contracts";

export { SEMANTIC_MAPPING_PROMPT_VERSION };

export const SEMANTIC_MAPPING_DEVELOPER_PROMPT = `You propose semantic column mappings between two dataset profiles.

Use only the supplied column metadata. Map meaning, not name similarity alone. Never invent a column. Do not infer row-level identity and do not describe whether any records are the same entity. Columns may remain unmapped. Do not force one-to-one mappings when the semantics do not justify them.

Use equivalent only when the fields represent the same concept. Use related_but_not_equivalent for fields that are useful together but do not mean the same thing, derived when one appears computed from another, and unknown when the relationship cannot be established. Mark fields useful for deciding entity identity as identity; mark fields intended for comparison after identity as comparison. Give concise reasons grounded in column names, types, and rates. Treat confidence as a cautious suggestion score, not scientific certainty. Normalization hints are advisory and must come from the supplied schema.`;
