import { describe, expect, it } from 'vitest'
import { compareRuns, formatCompareTable } from '../src/compare.js'
import type { RunRecord } from '../src/types.js'

function makeRun(
  id: string,
  scores: Array<{ scenarioId: string; value: number; axis?: string }>,
  opts: { scenarioSetHash?: string, runners?: string[] } = {},
): RunRecord {
  const runners = opts.runners ?? [`stub:${id}`]
  return {
    id,
    dataset: { name: 'test', version: '0.1.0' },
    scenarioSetHash: opts.scenarioSetHash ?? 'hash:matched',
    runners,
    createdAt: new Date().toISOString(),
    responses: [],
    scores: scores.map((s) => ({
      runnerId: runners[0] ?? `stub:${id}`,
      scenarioId: s.scenarioId,
      axis: s.axis ?? 'quality',
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

  it('emits paired-bootstrap interval metadata for matched scenario sets', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', value: 0.4 },
      { scenarioId: 's2', value: 0.6 },
      { scenarioId: 's3', value: 0.8 },
    ])
    const run2 = makeRun('b', [
      { scenarioId: 's1', value: 0.5 },
      { scenarioId: 's2', value: 0.9 },
      { scenarioId: 's3', value: 0.7 },
    ])

    const result = compareRuns(run1, run2, {
      iterations: 100,
      confidenceLevel: 0.9,
      seed: 13,
    })

    expect(result.interval).toMatchObject({
      method: 'paired-bootstrap',
      status: 'available',
      promotionClaimSupported: true,
      descriptiveOnly: false,
      pairedScenarioCount: 3,
      totalScenarioCount: 3,
      warnings: [],
      scenarioSetHash: {
        run1: 'hash:matched',
        run2: 'hash:matched',
        status: 'match',
      },
    })
    expect(result.interval.confidenceInterval).toMatchObject({
      method: 'paired-bootstrap',
      confidenceLevel: 0.9,
      iterations: 100,
      seed: 13,
      n: 3,
    })
  })

  it('withholds promotion intervals and warns when scenario-set hashes differ', () => {
    const run1 = makeRun('a', [{ scenarioId: 's1', value: 0.4 }], {
      scenarioSetHash: 'hash:one',
    })
    const run2 = makeRun('b', [{ scenarioId: 's1', value: 0.7 }], {
      scenarioSetHash: 'hash:two',
    })

    const result = compareRuns(run1, run2)

    expect(result.compositeDelta).toBeCloseTo(0.3)
    expect(result.interval.status).toBe('unavailable')
    expect(result.interval.confidenceInterval).toBeNull()
    expect(result.interval.promotionClaimSupported).toBe(false)
    expect(result.interval.descriptiveOnly).toBe(true)
    expect(result.interval.scenarioSetHash.status).toBe('mismatch')
    expect(result.interval.warnings.join('\n')).toContain('scenario-set hashes differ')
  })

  it('withholds promotion intervals and warns when paired scenarios are incomplete', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', value: 0.4 },
      { scenarioId: 's2', value: 0.6 },
    ])
    const run2 = makeRun('b', [{ scenarioId: 's1', value: 0.7 }])

    const result = compareRuns(run1, run2)

    expect(result.interval.status).toBe('unavailable')
    expect(result.interval.missingFromRun2).toEqual(['s2'])
    expect(result.interval.warnings.join('\n')).toContain('paired comparison incomplete')
  })

  it('withholds promotion intervals when paired scenario score keys differ', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', axis: 'quality', value: 0.4 },
      { scenarioId: 's1', axis: 'safety', value: 0.6 },
    ])
    const run2 = makeRun('b', [
      { scenarioId: 's1', axis: 'quality', value: 0.7 },
    ])

    const result = compareRuns(run1, run2)

    expect(result.interval.status).toBe('unavailable')
    expect(result.interval.promotionClaimSupported).toBe(false)
    expect(result.interval.missingScoreKeysFromRun2).toEqual([
      's1/safety (run1=1, run2=0)',
    ])
    expect(result.interval.warnings.join('\n')).toContain(
      'paired comparison score keys differ',
    )
  })

  it('withholds promotion intervals for invalid bootstrap options', () => {
    const run1 = makeRun('a', [
      { scenarioId: 's1', value: 0.4 },
      { scenarioId: 's2', value: 0.6 },
    ])
    const run2 = makeRun('b', [
      { scenarioId: 's1', value: 0.7 },
      { scenarioId: 's2', value: 0.9 },
    ])

    const result = compareRuns(run1, run2, {
      iterations: 0,
      confidenceLevel: 1,
    })

    expect(result.interval.status).toBe('unavailable')
    expect(result.interval.confidenceInterval).toBeNull()
    expect(result.interval.promotionClaimSupported).toBe(false)
    expect(result.interval.warnings.join('\n')).toContain(
      'invalid paired-bootstrap iterations 0',
    )
    expect(result.interval.warnings.join('\n')).toContain(
      'invalid paired-bootstrap confidence level 1',
    )
  })

  it('fails clearly for multi-runner RunRecords', () => {
    const run1 = makeRun('a', [{ scenarioId: 's1', value: 0.4 }], {
      runners: ['stub:a', 'stub:b'],
    })
    const run2 = makeRun('b', [{ scenarioId: 's1', value: 0.7 }])

    expect(() => compareRuns(run1, run2)).toThrow(/contains multiple runners/)
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

  it('documents descriptive-only deltas when no interval is available', () => {
    const run1 = makeRun('r1', [{ scenarioId: 'sc-001', value: 0.5 }], {
      scenarioSetHash: 'hash:one',
    })
    const run2 = makeRun('r2', [{ scenarioId: 'sc-001', value: 0.75 }], {
      scenarioSetHash: 'hash:two',
    })
    const table = formatCompareTable(compareRuns(run1, run2))

    expect(table).toContain('non-interval deltas are descriptive, not promotion claims')
    expect(table).toContain('warning: scenario-set hashes differ')
  })
})
