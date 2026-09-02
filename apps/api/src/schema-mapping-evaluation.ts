export interface SchemaMappingPair {
  leftColumn: string;
  rightColumn: string;
}

export interface SchemaMappingEvaluation {
  expectedMappingCount: number;
  proposedMappingCount: number;
  exactCorrectMappingCount: number;
  incorrectMappingCount: number;
  missedExpectedMappingCount: number;
  extraProposedMappingCount: number;
  precision: number | null;
  recall: number | null;
}

export function evaluateSchemaMappings(
  proposed: SchemaMappingPair[],
  expected: SchemaMappingPair[],
): SchemaMappingEvaluation {
  const key = (pair: SchemaMappingPair) => `${pair.leftColumn}\0${pair.rightColumn}`;
  const expectedKeys = new Set(expected.map(key));
  const expectedByLeft = new Map(expected.map((pair) => [pair.leftColumn, pair.rightColumn]));
  const proposedKeys = new Set(proposed.map(key));
  const exactCorrectMappingCount = proposed.filter((pair) => expectedKeys.has(key(pair))).length;
  const incorrectMappingCount = proposed.filter((pair) => expectedByLeft.has(pair.leftColumn) && !expectedKeys.has(key(pair))).length;
  const extraProposedMappingCount = proposed.filter((pair) => !expectedByLeft.has(pair.leftColumn)).length;
  const missedExpectedMappingCount = expected.filter((pair) => !proposedKeys.has(key(pair))).length;
  return {
    expectedMappingCount: expected.length,
    proposedMappingCount: proposed.length,
    exactCorrectMappingCount,
    incorrectMappingCount,
    missedExpectedMappingCount,
    extraProposedMappingCount,
    precision: proposed.length === 0 ? null : exactCorrectMappingCount / proposed.length,
    recall: expected.length === 0 ? null : exactCorrectMappingCount / expected.length,
  };
}
