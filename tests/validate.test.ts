import { describe, expect, it } from 'vitest'
import {
  ClaimEligibilityError,
  assertRunClaimEligible,
  assertValidRunRecord,
  validateClaimCard,
  validateRunRecord,
} from '../src/validate.js'
import type { ClaimCard, Dataset, RunRecord } from '../src/types.js'
import { computeScenarioSetHash, computeScenarioSetHashV2 } from '../src/serialiser.js'

function dataset(): Dataset {
  return {
    name: 'test-ds',
    version: '1.0.0',
    scenarios: ['tp', 'tn', 'fp-guard', 'fn-guard'].map((outcomeType, index) => ({
      id: `sc-${index + 1}`,
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: `hello ${index + 1}` }] },
      rubric: { kind: 'programmatic', checker: 'keyword', params: { expected: ['hello'] } },
      meta: { outcomeType },
    })),
  }
}

function minimalRecord(): RunRecord {
  const ds = dataset()
  return {
    id: 'run-001',
    dataset: { name: ds.name, version: ds.version },
    scenarioSetHash: computeScenarioSetHash(ds),
    runners: ['stub:echo'],
    createdAt: new Date().toISOString(),
    responses: ds.scenarios.map((scenario) => ({
        runnerId: 'stub:echo',
      scenarioId: scenario.id,
        output: 'hello',
        meta: { provider: 'stub', model: 'echo', accessedAt: new Date().toISOString(), latencyMs: 10 },
    })),
    scores: ds.scenarios.map((scenario) => ({
      runnerId: 'stub:echo',
      scenarioId: scenario.id,
      axis: 'quality',
      value: 0.8,
      claimStatus: 'programmatic',
    })),
    aggregates: [
      {
        runnerId: 'stub:echo',
        axes: {
          quality: {
            mean: 0.8,
            variance: 0,
            n: ds.scenarios.length,
            confidenceInterval: {
              method: 'bootstrap',
              lower: 0.7,
              upper: 0.9,
              confidenceLevel: 0.95,
              iterations: 1000,
              seed: 1,
              n: ds.scenarios.length,
            },
          },
        },
        composite: 0.8,
        weights: { quality: 1 },
        statisticalClaims: {
          method: 'bootstrap',
          confidenceLevel: 0.95,
          iterations: 1000,
          seed: 1,
          sampleUnit: 'score',
        },
      },
    ],
    meta: { harnessVersion: '0.4.0' },
  }
}

describe('validateRunRecord', () => {
  it('accepts a valid minimal legacy v0 RunRecord without scenario-set hash metadata', () => {
    const r = minimalRecord()
    delete r.scenarioSetHash

    const result = validateRunRecord(r)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a legacy v1 RunRecord with only a bare scenarioSetHash', () => {
    const r = minimalRecord()
    r.scenarioSetHash = 'a'.repeat(64)

    const result = validateRunRecord(r)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a v2 RunRecord with additive scenario-set hash metadata', () => {
    const r = minimalRecord()
    const metadata = computeScenarioSetHashV2(
      {
        name: r.dataset.name,
        version: r.dataset.version,
        scenarios: [
          {
            id: 'sc-1',
            axes: ['quality'],
            input: { messages: [{ role: 'user', content: 'hello' }] },
            rubric: { kind: 'programmatic', checker: 'non-empty' },
          },
        ],
      },
      {
        domain: 'adtech',
        plugin: { id: 'agentsia.assay-adtech', version: '1.8.0-rc.4' },
        implementationFingerprints: [{ id: 'assay-harness:runner-visible-input', version: '1' }],
        scorerFingerprints: [{ id: 'assay-harness:programmatic-rubric', version: '1' }],
      },
    )
    r.scenarioSetHashSchemaVersion = metadata.hashSchemaVersion
    r.scenarioSetHash = metadata.scenarioSetHash
    r.scenarioSetHashMetadata = metadata

    const result = validateRunRecord(r)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('fails closed on unknown scenario-set hash schema versions', () => {
    const r = minimalRecord()
    const raw = r as unknown as Record<string, unknown>
    raw['scenarioSetHashSchemaVersion'] = 'v999'
    r.scenarioSetHash = 'b'.repeat(64)
    raw['scenarioSetHashMetadata'] = {
      hashSchemaVersion: 'v999',
      scenarioSetHash: r.scenarioSetHash,
    }

    const result = validateRunRecord(r)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('unknown scenario-set hash schema version')
  })

  it('rejects v2 metadata whose hash does not match RunRecord.scenarioSetHash', () => {
    const r = minimalRecord()
    const metadata = computeScenarioSetHashV2(
      {
        name: r.dataset.name,
        version: r.dataset.version,
        scenarios: [
          {
            id: 'sc-1',
            axes: ['quality'],
            input: { messages: [{ role: 'user', content: 'hello' }] },
            rubric: { kind: 'programmatic', checker: 'non-empty' },
          },
        ],
      },
      {
        domain: 'adtech',
        plugin: { id: 'agentsia.assay-adtech', version: '1.8.0-rc.4' },
        implementationFingerprints: [{ id: 'assay-harness:runner-visible-input', version: '1' }],
        scorerFingerprints: [{ id: 'assay-harness:programmatic-rubric', version: '1' }],
      },
    )
    r.scenarioSetHashSchemaVersion = metadata.hashSchemaVersion
    r.scenarioSetHash = 'c'.repeat(64)
    r.scenarioSetHashMetadata = metadata

    const result = validateRunRecord(r)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain(
      'RunRecord.scenarioSetHashMetadata.scenarioSetHash must match RunRecord.scenarioSetHash',
    )
  })

  it('rejects a non-object', () => {
    const result = validateRunRecord('not an object')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/plain object/)
  })

  it('reports missing id', () => {
    const r = minimalRecord()
    delete (r as unknown as Record<string, unknown>)['id']
    const result = validateRunRecord(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('RunRecord.id'))).toBe(true)
  })

  it('reports a score value outside [0, 1]', () => {
    const r = minimalRecord()
    r.scores[0].value = 1.5
    const result = validateRunRecord(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('value'))).toBe(true)
  })

  it('reports missing meta.harnessVersion', () => {
    const r = minimalRecord()
    delete (r.meta as Record<string, unknown>)['harnessVersion']
    const result = validateRunRecord(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('harnessVersion'))).toBe(true)
  })

  it('reports a response with non-finite latencyMs', () => {
    const r = minimalRecord()
    r.responses[0].meta.latencyMs = NaN
    const result = validateRunRecord(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('latencyMs'))).toBe(true)
  })
})

describe('assertValidRunRecord', () => {
  it('does not throw for a valid record', () => {
    expect(() => assertValidRunRecord(minimalRecord())).not.toThrow()
  })

  it('throws with a descriptive message for an invalid record', () => {
    expect(() => assertValidRunRecord({ not: 'a run record' })).toThrow(/RunRecord validation failed/)
  })
})

describe('claim card validation and eligibility', () => {
  function claimCard(record = minimalRecord(), overrides: Partial<ClaimCard> = {}): ClaimCard {
    return {
      schemaVersion: 'assay.claim-card.v1',
      dataset: record.dataset,
      scenarioSetHash: record.scenarioSetHash!,
      hashSchemaVersion: record.scenarioSetHashSchemaVersion ?? 'v1',
      status: 'allowed',
      leaderboardClaimsAllowed: true,
      generatedAt: '2026-06-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      quorum: { required: 1, providers: ['stub'] },
      providerCells: [
        {
          provider: 'stub',
          model: 'echo',
          status: 'verified',
          generatedAt: '2026-06-20T00:00:00.000Z',
          expiresAt: '2026-07-20T00:00:00.000Z',
        },
      ],
      ...overrides,
    }
  }

  it('validates a well-formed claim card', () => {
    const result = validateClaimCard(claimCard(), '2026-06-21T00:00:00.000Z')

    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('rejects expired claim cards and blocked claim cards', () => {
    expect(
      validateClaimCard(
        claimCard(undefined, { expiresAt: '2026-06-01T00:00:00.000Z' }),
        '2026-06-21T00:00:00.000Z',
      ).errors,
    ).toContain('ClaimCard has expired')

    expect(() =>
      assertRunClaimEligible(minimalRecord(), {
        dataset: dataset(),
        claimCard: claimCard(undefined, {
          status: 'blocked',
          leaderboardClaimsAllowed: false,
          blocker: 'frontier quorum pending',
        }),
        now: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow(ClaimEligibilityError)
  })

  it('fails claim eligibility on analysis-only scores and stale quorum cells', () => {
    const record = minimalRecord()
    record.scores[0].claimStatus = 'analysis-only'

    expect(() =>
      assertRunClaimEligible(record, {
        dataset: dataset(),
        claimCard: claimCard(record, {
          providerCells: [{ provider: 'stub', status: 'stale' }],
        }),
        now: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow(/analysis-only|quorum/)
  })

  it('passes claim eligibility when corpus, card, statistics, and stratification agree', () => {
    const record = minimalRecord()

    expect(() =>
      assertRunClaimEligible(record, {
        dataset: dataset(),
        claimCard: claimCard(record),
        now: '2026-06-21T00:00:00.000Z',
      }),
    ).not.toThrow()
  })
})
