import { describe, expect, it } from 'vitest'
import { validateRunRecord, assertValidRunRecord } from '../src/validate.js'
import type { RunRecord } from '../src/types.js'
import { computeScenarioSetHashV2 } from '../src/serialiser.js'

function minimalRecord(): RunRecord {
  return {
    id: 'run-001',
    dataset: { name: 'test-ds', version: '1.0.0' },
    runners: ['stub:echo'],
    createdAt: new Date().toISOString(),
    responses: [
      {
        runnerId: 'stub:echo',
        scenarioId: 'sc-1',
        output: 'hello',
        meta: { provider: 'stub', model: 'echo', accessedAt: new Date().toISOString(), latencyMs: 10 },
      },
    ],
    scores: [{ runnerId: 'stub:echo', scenarioId: 'sc-1', axis: 'quality', value: 0.8 }],
    aggregates: [
      {
        runnerId: 'stub:echo',
        axes: { quality: { mean: 0.8, variance: 0, n: 1 } },
        composite: 0.8,
        weights: { quality: 1 },
      },
    ],
    meta: { harnessVersion: '0.4.0' },
  }
}

describe('validateRunRecord', () => {
  it('accepts a valid minimal legacy v0 RunRecord without scenario-set hash metadata', () => {
    const result = validateRunRecord(minimalRecord())
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
