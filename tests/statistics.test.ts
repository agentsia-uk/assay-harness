import { describe, expect, it } from 'vitest'

import {
  aggregate,
  comparePairedScores,
} from '../src/aggregator.js'
import type { ModelResponse, Score } from '../src/types.js'

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

  it('adds deterministic repeated-run reliability, slice, and metadata fallback metrics', () => {
    const repeatedScores: Score[] = [
      { runnerId: 'model:a', scenarioId: 's1', axis: 'quality', value: 0.2 },
      { runnerId: 'model:a', scenarioId: 's1', axis: 'quality', value: 0.8 },
      { runnerId: 'model:a', scenarioId: 's2', axis: 'quality', value: 0.9 },
      { runnerId: 'model:a', scenarioId: 's2', axis: 'quality', value: 0.7 },
      { runnerId: 'model:a', scenarioId: 's3', axis: 'quality', value: 0.1 },
    ]
    const responses: ModelResponse[] = [
      makeResponse('model:a', 's1', 100, { promptTokens: 10, completionTokens: 5, costUsd: 0.01 }),
      makeResponse('model:a', 's1', 200, { promptTokens: 12, completionTokens: 6, costUsd: 0.02 }),
      makeResponse('model:a', 's2', 300, { inputTokens: 7, outputTokens: 3, refusal: true }),
      makeResponse('model:a', 's3', 400, {}),
    ]

    const [aggregateA] = aggregate(repeatedScores, {
      responses,
      sliceMetadataByScenario: {
        s1: { family: 'facts' },
        s2: { family: 'facts' },
      },
      confidence: {
        method: 'bootstrap',
        iterations: 50,
        confidenceLevel: 0.9,
        seed: 5,
      },
    })

    expect(aggregateA.reliability).toMatchObject({
      passThreshold: 0.5,
      passAtK: 2 / 3,
      passPowerK: 1 / 3,
      repeatedScenarioCount: 2,
      evaluatedScenarioCount: 3,
      sampleCount: 5,
    })
    expect(aggregateA.operational).toMatchObject({
      responseCount: 4,
      meanLatencyMs: 250,
      totalPromptTokens: 29,
      totalCompletionTokens: 14,
      totalCostUsd: 0.03,
      refusalRate: 0.25,
      missingMetadata: {
        tokenCount: 1,
        cost: 2,
      },
    })
    expect(aggregateA.slices?.['family=facts']).toMatchObject({
      n: 4,
      reliability: {
        passAtK: 1,
        passPowerK: 0.5,
      },
    })
    expect(aggregateA.slices?.['family=facts'].composite).toBeCloseTo(0.65)
    expect(aggregateA.slices?.['__unsliced__']).toMatchObject({
      composite: 0.1,
      n: 1,
      reliability: {
        passAtK: 0,
        passPowerK: 0,
      },
    })
    expect(aggregateA.slices?.['__unsliced__'].axes.quality.confidenceInterval).toMatchObject({
      method: 'bootstrap',
      n: 1,
    })
  })
})

function makeResponse(
  runnerId: string,
  scenarioId: string,
  latencyMs: number,
  extra: Record<string, unknown>,
): ModelResponse {
  return {
    runnerId,
    scenarioId,
    output: '',
    meta: {
      provider: 'stub',
      model: 'echo',
      accessedAt: '2026-06-25T00:00:00.000Z',
      latencyMs,
      extra,
    },
  }
}
