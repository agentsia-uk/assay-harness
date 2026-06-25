import { describe, expect, it } from 'vitest'

import type { Dataset, EnvironmentScenario, Scenario } from '../src/types.js'
import {
  SCENARIO_SET_HASH_SCHEMA_V2,
  UnknownScenarioSetHashSchemaError,
  computeScenarioSetHashBySchema,
  computeScenarioSetHashV2,
} from '../src/serialiser.js'

function scenario(id: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    id,
    axes: ['accuracy'],
    input: {
      messages: [
        { role: 'system', content: 'Answer as an adtech operations analyst.' },
        { role: 'user', content: `diagnose ${id}` },
      ],
    },
    rubric: { kind: 'programmatic', checker: 'non-empty' },
    ...overrides,
  }
}

function dataset(scenarios: Scenario[]): Dataset {
  return {
    name: 'assay-adtech',
    version: '1.8.0-rc.4',
    scenarios,
  }
}

const v2Options = {
  domain: 'adtech',
  plugin: { id: 'agentsia.assay-adtech', version: '1.8.0-rc.4' },
  implementationFingerprints: [
    { id: 'assay-harness:runner-visible-input', version: '1' },
  ],
  scorerFingerprints: [
    { id: 'assay-harness:programmatic-rubric', version: '1' },
  ],
}

describe('scenario-set hash schema v2', () => {
  it('computes additive public metadata around a deterministic v2 hash', () => {
    const metadata = computeScenarioSetHashV2(
      dataset([scenario('s2'), scenario('s1')]),
      v2Options,
    )

    expect(metadata.hashSchemaVersion).toBe(SCENARIO_SET_HASH_SCHEMA_V2)
    expect(metadata.scenarioSetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(metadata.shortHash).toBe(metadata.scenarioSetHash.slice(0, 12))
    expect(metadata.dataset).toEqual({
      name: 'assay-adtech',
      version: '1.8.0-rc.4',
    })
    expect(metadata.domain).toBe('adtech')
    expect(metadata.plugin).toEqual({ id: 'agentsia.assay-adtech', version: '1.8.0-rc.4' })
    expect(metadata.axes).toEqual(['accuracy'])
    expect(metadata.scenarioCount).toBe(2)
    expect(metadata.hashedFields).toEqual(
      expect.arrayContaining([
        'hashSchemaVersion',
        'dataset.name',
        'dataset.version',
        'domain',
        'plugin',
        'scenario.id',
        'scenario.runnerVisibleInput',
        'scenario.axes',
        'scenario.rubricDescriptor',
        'scenario.scoringDescriptor',
        'scenario.multiTurnShape',
        'scenario.multiTurnRunnerVisibleInput',
        'scenario.environmentShape',
        'scenario.environmentRunnerVisibleInput',
        'implementationFingerprints',
        'scorerFingerprints',
      ]),
    )
    expect(metadata.excludedPrivateFields).toEqual(
      expect.arrayContaining(['privateAnswerKey', 'goldAnswer', 'mechanismAliases']),
    )
  })

  it('is order-independent but changes on runner-visible input, axes, rubric, domain, plugin, and fingerprints', () => {
    const base = dataset([scenario('s1'), scenario('s2')])
    const reordered = dataset([scenario('s2'), scenario('s1')])
    const baseHash = computeScenarioSetHashV2(base, v2Options).scenarioSetHash

    expect(computeScenarioSetHashV2(reordered, v2Options).scenarioSetHash).toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([
          scenario('s1', {
            input: { messages: [{ role: 'user', content: 'changed prompt' }] },
          }),
          scenario('s2'),
        ]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([scenario('s1', { axes: ['accuracy', 'latency'] }), scenario('s2')]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([
          scenario('s1', { rubric: { kind: 'programmatic', checker: 'exact-match' } }),
          scenario('s2'),
        ]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(base, { ...v2Options, domain: 'retail' }).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(base, {
        ...v2Options,
        plugin: { id: 'agentsia.assay-adtech', version: '1.8.0-rc.5' },
      }).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(base, {
        ...v2Options,
        scorerFingerprints: [{ id: 'assay-harness:programmatic-rubric', version: '2' }],
      }).scenarioSetHash,
    ).not.toBe(baseHash)
  })

  it('hashes multi-turn shape while excluding private answer-key fields from public identity', () => {
    const base = dataset([
      scenario('single', {
        input: { messages: [{ role: 'user', content: 'remember this budget' }] },
        meta: { note: 'cosmetic' },
      }),
    ])
    const baseHash = computeScenarioSetHashV2(base, v2Options).scenarioSetHash

    const withPrivateKeys = dataset([
      scenario('single', {
        input: {
          messages: [{ role: 'user', content: 'remember this budget' }],
          meta: {
            privateAnswerKey: {
              expectedDisposition: 'refuse-refund',
            },
          },
        },
        meta: {
          note: 'changed cosmetic note',
          goldAnswer: 'private held-out answer',
          mechanismAliases: { mfa: ['made for advertising'] },
        },
      }),
    ])

    expect(computeScenarioSetHashV2(withPrivateKeys, v2Options).scenarioSetHash).toBe(baseHash)

    const multiTurn = dataset([
      scenario('single', {
        input: { messages: [{ role: 'user', content: 'remember this budget' }] },
        meta: { multiTurn: true },
      }),
    ])

    const metadata = computeScenarioSetHashV2(multiTurn, v2Options)
    expect(metadata.scenarioSetHash).not.toBe(baseHash)
    expect(metadata.multiTurn).toMatchObject({
      scenarioCount: 1,
      multiTurnScenarioCount: 1,
      singleTurnScenarioCount: 0,
      maxRunnerVisibleTurns: 1,
    })
  })

  it('hashes top-level multi-turn seed history and user-turn text', () => {
    const baseMultiTurn = {
      ...scenario('multi'),
      seedHistory: [
        { role: 'user', content: 'The bidder is blocked on a US-only PMP deal.' },
        { role: 'assistant', content: 'Check deal eligibility and geo filters.' },
      ],
      userTurns: ['Now diagnose why the bid is still rejected.'],
      persistenceCriteria: ['The answer must preserve the original geo constraint.'],
    } as Scenario
    const changedTurn = {
      ...baseMultiTurn,
      userTurns: ['Now diagnose why the bid floor is still too high.'],
    } as Scenario

    const baseHash = computeScenarioSetHashV2(dataset([baseMultiTurn]), v2Options)
      .scenarioSetHash
    expect(computeScenarioSetHashV2(dataset([changedTurn]), v2Options).scenarioSetHash)
      .not.toBe(baseHash)
  })

  it('hashes environment setup, tool policy, and state validators', () => {
    const baseEnvironment = {
      ...scenario('stateful'),
      environment: {
        environmentId: 'fixture:counter',
        setup: { initial: 0 },
        maxSteps: 2,
        toolPolicy: { allowedToolNames: ['counter.add'], maxCalls: 2 },
        validators: [{ id: 'count-equals', params: { expected: 5 } }],
      },
    } satisfies EnvironmentScenario
    const baseHash = computeScenarioSetHashV2(dataset([baseEnvironment]), v2Options)
      .scenarioSetHash
    const changedSetup: EnvironmentScenario = {
      ...baseEnvironment,
      environment: {
        ...baseEnvironment.environment,
        setup: { initial: 1 },
      },
    }
    const changedToolPolicy: EnvironmentScenario = {
      ...baseEnvironment,
      environment: {
        ...baseEnvironment.environment,
        toolPolicy: { allowedToolNames: ['counter.subtract'], maxCalls: 2 },
      },
    }
    const changedValidator: EnvironmentScenario = {
      ...baseEnvironment,
      environment: {
        ...baseEnvironment.environment,
        validators: [{ id: 'count-equals', params: { expected: 4 } }],
      },
    }

    expect(
      computeScenarioSetHashV2(
        dataset([changedSetup]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([changedToolPolicy]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([changedValidator]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)
  })

  it('hashes public mechanism matcher and anti-bingo token strings', () => {
    const mechanismRubric = {
      kind: 'mechanism' as const,
      quantitative: [{ label: 'floor', matchers: ['floor increased by 20%', '20 percent'] }],
      disambiguation: [{ label: 'auction', matchers: ['first-price auction'] }],
      actions: [{ label: 'action', matchers: ['lower the pmp floor'] }],
      bingoTokens: ['bid floor', 'pmp'],
    }
    const baseHash = computeScenarioSetHashV2(
      dataset([scenario('mechanism', { rubric: mechanismRubric })]),
      v2Options,
    ).scenarioSetHash

    expect(
      computeScenarioSetHashV2(
        dataset([
          scenario('mechanism', {
            rubric: {
              ...mechanismRubric,
              quantitative: [{ label: 'floor', matchers: ['floor increased by 30%', '30 percent'] }],
            },
          }),
        ]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)

    expect(
      computeScenarioSetHashV2(
        dataset([
          scenario('mechanism', {
            rubric: {
              ...mechanismRubric,
              bingoTokens: ['auction', 'pmp'],
            },
          }),
        ]),
        v2Options,
      ).scenarioSetHash,
    ).not.toBe(baseHash)
  })

  it('fails closed when asked to compute an unknown hash schema version', () => {
    expect(() =>
      computeScenarioSetHashBySchema(dataset([scenario('s1')]), {
        hashSchemaVersion: 'v999',
        ...v2Options,
      } as never),
    ).toThrow(UnknownScenarioSetHashSchemaError)
  })
})
