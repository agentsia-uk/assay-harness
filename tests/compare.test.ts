import { describe, expect, it } from 'vitest'
import { compareRuns, formatCompareTable } from '../src/compare.js'
import type { RunRecord } from '../src/types.js'

function makeRun(id: string, scores: Array<{ scenarioId: string; value: number }>): RunRecord {
  return {
    id,
    dataset: { name: 'test', version: '0.1.0' },
    runners: [`stub:${id}`],
    createdAt: new Date().toISOString(),
    responses: [],
    scores: scores.map((s) => ({
      runnerId: `stub:${id}`,
      scenarioId: s.scenarioId,
      axis: 'quality',
      value: s.value,
    })),
    aggregates: [],
    meta: { harnessVersion: '0.0.0' },
  }
}

describe('compareRuns', () => {
  it('computes delta and direction for paired scenarios', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', value: 0.5 },
      { scenarioId: 's2', value: 0.8 },
    ])
    const run2 = makeRun('b', [
      { scenarioId: 's1', value: 0.7 },
      { scenarioId: 's2', value: 0.6 },
    ])
    const result = compareRuns(run1, run2)
    expect(result.rows).toHaveLength(2)

    const s1 = result.rows.find((r) => r.scenarioId === 's1')!
    expect(s1.score1).toBeCloseTo(0.5)
    expect(s1.score2).toBeCloseTo(0.7)
    expect(s1.delta).toBeCloseTo(0.2)
    expect(s1.direction).toBe('improvement')

    const s2 = result.rows.find((r) => r.scenarioId === 's2')!
    expect(s2.delta).toBeCloseTo(-0.2)
    expect(s2.direction).toBe('regression')
  })

  it('marks scenarios missing from run2 as missing', () => {
    const run1 = makeRun('a', [{ scenarioId: 's1', value: 0.5 }])
    const run2 = makeRun('b', [{ scenarioId: 's2', value: 0.9 }])
    const result = compareRuns(run1, run2)
    expect(result.rows).toHaveLength(2)
    const s1 = result.rows.find((r) => r.scenarioId === 's1')!
    expect(s1.score2).toBeNull()
    expect(s1.delta).toBeNull()
    expect(s1.direction).toBe('missing')
  })

  it('marks a delta within 0.001 as unchanged', () => {
    const run1 = makeRun('a', [{ scenarioId: 's1', value: 0.5 }])
    const run2 = makeRun('b', [{ scenarioId: 's1', value: 0.5005 }])
    const result = compareRuns(run1, run2)
    expect(result.rows[0]?.direction).toBe('unchanged')
  })

  it('computes composite delta as mean of paired deltas', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', value: 0.4 },
      { scenarioId: 's2', value: 0.6 },
    ])
    const run2 = makeRun('b', [
      { scenarioId: 's1', value: 0.6 },
      { scenarioId: 's2', value: 0.8 },
    ])
    const result = compareRuns(run1, run2)
    expect(result.compositeDelta).toBeCloseTo(0.2)
  })
})

describe('formatCompareTable', () => {
  it('produces a non-empty table string with expected headers', () => {
    const run1 = makeRun('r1', [{ scenarioId: 'sc-001', value: 0.5 }])
    const run2 = makeRun('r2', [{ scenarioId: 'sc-001', value: 0.75 }])
    const result = compareRuns(run1, run2)
    const table = formatCompareTable(result)
    expect(table).toContain('run1')
    expect(table).toContain('run2')
    expect(table).toContain('delta')
    expect(table).toContain('sc-001')
    expect(table).toContain('+')
  })
})
