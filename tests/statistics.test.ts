import { describe, expect, it } from 'vitest'

import {
  aggregate,
  comparePairedScores,
} from '../src/aggregator.js'
import type { Score } from '../src/types.js'

const scores: Score[] = [
  { runnerId: 'model:a', scenarioId: 's1', axis: 'quality', value: 1 },
  { runnerId: 'model:a', scenarioId: 's2', axis: 'quality', value: 0 },
  { runnerId: 'model:a', scenarioId: 's3', axis: 'quality', value: 1 },
  { runnerId: 'model:a', scenarioId: 's4', axis: 'quality', value: 1 },
  { runnerId: 'model:b', scenarioId: 's1', axis: 'quality', value: 0 },
  { runnerId: 'model:b', scenarioId: 's2', axis: 'quality', value: 0 },
  { runnerId: 'model:b', scenarioId: 's3', axis: 'quality', value: 1 },
  { runnerId: 'model:b', scenarioId: 's4', axis: 'quality', value: 0 },
]

describe('statistical benchmark claims', () => {
  it('adds deterministic bootstrap intervals and method metadata to aggregates', () => {
    const [aggregateA] = aggregate(scores, {
      confidence: {
        method: 'bootstrap',
        iterations: 250,
        confidenceLevel: 0.95,
        seed: 11,
      },
    })

    expect(aggregateA.axes.quality.confidenceInterval).toMatchObject({
      method: 'bootstrap',
      confidenceLevel: 0.95,
      iterations: 250,
      seed: 11,
      n: 4,
    })
    expect(aggregateA.axes.quality.confidenceInterval?.lower).toBeGreaterThanOrEqual(0)
    expect(aggregateA.axes.quality.confidenceInterval?.upper).toBeLessThanOrEqual(1)
    expect(aggregateA.statisticalClaims?.method).toBe('bootstrap')
  })

  it('reports paired confidence intervals for same-scenario model deltas', () => {
    const comparison = comparePairedScores(scores, {
      baselineRunnerId: 'model:b',
      candidateRunnerId: 'model:a',
      confidenceLevel: 0.95,
      iterations: 250,
      seed: 7,
    })

    expect(comparison.baselineRunnerId).toBe('model:b')
    expect(comparison.candidateRunnerId).toBe('model:a')
    expect(comparison.n).toBe(4)
    expect(comparison.delta).toBe(0.5)
    expect(comparison.confidenceInterval.method).toBe('paired-bootstrap')
    expect(comparison.confidenceInterval.lower).toBeLessThanOrEqual(comparison.delta)
    expect(comparison.confidenceInterval.upper).toBeGreaterThanOrEqual(comparison.delta)
  })
})
