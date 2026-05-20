/**
 * Cross-repo contract fixture validation — consumer side (assay-harness#11).
 *
 * This vitest suite IS the CI step required by issue #11: `pnpm test` runs in
 * CI, so loading the mirrored Modelsmith fixtures here and validating them
 * against the strict structural validator satisfies the "CI step that loads
 * the mirrored fixture and validates it against the schema" acceptance
 * criterion without touching `.github/workflows/ci.yml`.
 *
 * Mirrors Modelsmith#2081 (epic #2077). Canonical contract matrix:
 * Modelsmith `docs/internal/cross-repo-contracts.md` + `ADR-131`.
 *
 * The fixtures under `__tests__/fixtures/modelsmith-contracts/...` are copied
 * BYTE-FOR-BYTE from the Modelsmith producer-side fixtures so producer and
 * consumer stay aligned.
 */

import { describe, expect, it } from 'vitest'

import {
  CrossRepoContractError,
  ClaimGateBlockedError,
  assertLeaderboardClaimAllowed,
  loadAssayReleaseContractV2,
  validateAssayReleaseContractV2,
  validateSanitisedScenarioV1,
} from './cross-repo-contract-validator.js'

import assayReleaseMinimum from '../__tests__/fixtures/modelsmith-contracts/assay-release-contract/v2/example-minimum.json'
import assayReleaseSample from '../__tests__/fixtures/modelsmith-contracts/assay-release-contract/v2/example-sample.json'
import sanitisedScenarioMinimum from '../__tests__/fixtures/modelsmith-contracts/sanitised-scenario/v1/example-minimum.json'
import sanitisedScenarioSample from '../__tests__/fixtures/modelsmith-contracts/sanitised-scenario/v1/example-sample.json'

describe('assay-release-contract v2 — mirrored Modelsmith fixtures', () => {
  it('accepts the example-minimum.json fixture', () => {
    const contract = validateAssayReleaseContractV2(assayReleaseMinimum)
    expect(contract.schemaVersion).toBe('modelsmith.assay-release-contract.v2')
    expect(contract.benchmark).toBe('assay-adtech')
    expect(contract.scenarios).toEqual([])
  })

  it('accepts the example-sample.json fixture and validates every scenario', () => {
    const contract = validateAssayReleaseContractV2(assayReleaseSample)
    expect(contract.schemaVersion).toBe('modelsmith.assay-release-contract.v2')
    expect(contract.scenarios.length).toBeGreaterThan(0)
    expect(contract.scenarioCounts.totalInManifest).toBe(296)
    for (const scenario of contract.scenarios) {
      expect(scenario.id).toBeTruthy()
      expect(scenario.passCriteria).toBeTruthy()
      expect(scenario.failCriteria).toBeTruthy()
    }
  })
})

describe('sanitised-scenario v1 — mirrored Modelsmith fixtures', () => {
  it('accepts the example-minimum.json fixture', () => {
    const scenario = validateSanitisedScenarioV1(sanitisedScenarioMinimum)
    expect(scenario.id).toBe('ASSAY_ADTECH_FIXTURE_MINIMUM')
    expect(scenario.category).toBe('FIXTURE')
  })

  it('accepts the example-sample.json fixture', () => {
    const scenario = validateSanitisedScenarioV1(sanitisedScenarioSample)
    expect(scenario.id).toBe('ASSAY_ADTECH_ADVERSARIAL_CPM_VS_REVENUE')
    expect(scenario.outcomeType).toBe('fp-guard')
    expect(scenario.benchmarkTier).toBe('public_holdout')
  })
})

describe('claimGate refusal — blocked status', () => {
  it('the mirrored example fixtures carry a blocked claim gate', () => {
    // Both shipped Modelsmith fixtures use claimGate.status === "blocked"; this
    // pins that assumption so a future fixture refresh that flips the gate is
    // an explicit, visible change.
    const minimum = validateAssayReleaseContractV2(assayReleaseMinimum)
    const sample = validateAssayReleaseContractV2(assayReleaseSample)
    expect(minimum.claimGate.status).toBe('blocked')
    expect(sample.claimGate.status).toBe('blocked')
  })

  it('refuses a blocked contract for a leaderboard-claim run', () => {
    const contract = validateAssayReleaseContractV2(assayReleaseSample)
    expect(() => assertLeaderboardClaimAllowed(contract)).toThrow(
      ClaimGateBlockedError,
    )
    expect(() =>
      loadAssayReleaseContractV2(assayReleaseSample, { forLeaderboardClaim: true }),
    ).toThrow(ClaimGateBlockedError)
  })

  it('the blocked-claim error surfaces producer/consumer and the blocker reason', () => {
    const contract = validateAssayReleaseContractV2(assayReleaseSample)
    let caught: unknown
    try {
      assertLeaderboardClaimAllowed(contract)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClaimGateBlockedError)
    expect((caught as Error).message).toContain('agentsia-uk/Modelsmith')
    expect((caught as Error).message).toContain('agentsia-uk/assay-harness')
    expect((caught as Error).message).toContain('ADR-098 Phase 2')
  })

  it('still permits ingesting a blocked contract for an internal smoke run', () => {
    // Without `forLeaderboardClaim`, a blocked contract loads fine — the
    // refusal is leaderboard-claim-scoped, per the consumer-side snippet.
    const contract = loadAssayReleaseContractV2(assayReleaseSample)
    expect(contract.claimGate.status).toBe('blocked')
  })

  it('allows a synthetic contract whose claim gate is "allowed"', () => {
    const allowedContract = {
      ...(assayReleaseSample as Record<string, unknown>),
      claimGate: {
        status: 'allowed',
        leaderboardClaimsAllowed: true,
        gatedDomains: [],
      },
    }
    const contract = loadAssayReleaseContractV2(allowedContract, {
      forLeaderboardClaim: true,
    })
    expect(contract.claimGate.status).toBe('allowed')
  })
})

describe('strict validation — unexpected-key rejection (private-scenario-leak guard)', () => {
  it('rejects an unexpected top-level key on the contract', () => {
    const leaky = {
      ...(assayReleaseMinimum as Record<string, unknown>),
      goldSet: ['leaked-evaluator-only-field'],
    }
    expect(() => validateAssayReleaseContractV2(leaky)).toThrow(
      CrossRepoContractError,
    )
    expect(() => validateAssayReleaseContractV2(leaky)).toThrow(/unexpected key/)
  })

  it('rejects an unexpected top-level key on a sanitised scenario', () => {
    const leaky = {
      ...(sanitisedScenarioMinimum as Record<string, unknown>),
      negativeExamples: ['leaked-evaluator-only-field'],
    }
    expect(() => validateSanitisedScenarioV1(leaky)).toThrow(CrossRepoContractError)
    expect(() => validateSanitisedScenarioV1(leaky)).toThrow(/unexpected key/)
  })

  it('rejects an unexpected key on a scenario nested inside the contract', () => {
    const leakyScenario = {
      ...(sanitisedScenarioSample as Record<string, unknown>),
      expectedFailureModes: ['leaked'],
    }
    const contract = {
      ...(assayReleaseMinimum as Record<string, unknown>),
      scenarios: [leakyScenario],
    }
    expect(() => validateAssayReleaseContractV2(contract)).toThrow(
      /scenarios\[0\]\.expectedFailureModes/,
    )
  })

  it('rejects an unexpected key on a nested object (claimGate)', () => {
    const leaky = {
      ...(assayReleaseMinimum as Record<string, unknown>),
      claimGate: {
        status: 'blocked',
        leaderboardClaimsAllowed: false,
        gatedDomains: [],
        secretInternalNote: 'leak',
      },
    }
    expect(() => validateAssayReleaseContractV2(leaky)).toThrow(
      /claimGate\.secretInternalNote/,
    )
  })
})

describe('strict validation — missing and mistyped required fields', () => {
  it('rejects a contract missing a required field', () => {
    const broken = { ...(assayReleaseMinimum as Record<string, unknown>) }
    delete broken.scenarioSetHash
    expect(() => validateAssayReleaseContractV2(broken)).toThrow(
      CrossRepoContractError,
    )
  })

  it('rejects a contract with the wrong schemaVersion literal', () => {
    const broken = {
      ...(assayReleaseMinimum as Record<string, unknown>),
      schemaVersion: 'modelsmith.assay-release-contract.v3',
    }
    expect(() => validateAssayReleaseContractV2(broken)).toThrow(
      /expected literal/,
    )
  })

  it('rejects a sanitised scenario whose id is not a string', () => {
    const broken = { ...(sanitisedScenarioMinimum as Record<string, unknown>), id: 42 }
    expect(() => validateSanitisedScenarioV1(broken)).toThrow(CrossRepoContractError)
  })

  it('rejects a sanitised scenario with an unknown benchmarkTier', () => {
    const broken = {
      ...(sanitisedScenarioMinimum as Record<string, unknown>),
      benchmarkTier: 'private_only',
    }
    expect(() => validateSanitisedScenarioV1(broken)).toThrow(
      /benchmarkTier/,
    )
  })

  it('rejects a non-object input', () => {
    expect(() => validateAssayReleaseContractV2(null)).toThrow(CrossRepoContractError)
    expect(() => validateSanitisedScenarioV1('not-an-object')).toThrow(
      CrossRepoContractError,
    )
  })
})
