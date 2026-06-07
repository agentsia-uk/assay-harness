import { describe, expect, it } from 'vitest'
import { validateRunRecord, assertValidRunRecord } from '../src/validate.js'
import type { RunRecord } from '../src/types.js'

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
  it('accepts a valid minimal RunRecord', () => {
    const result = validateRunRecord(minimalRecord())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a non-object', () => {
    const result = validateRunRecord('not an object')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/plain object/)
  })

  it('reports missing id', () => {
    const r = minimalRecord()
    delete (r as Record<string, unknown>)['id']
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
