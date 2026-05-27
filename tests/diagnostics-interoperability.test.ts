import { describe, expect, it } from 'vitest'

import {
  analyseScenarioItems,
  compareScenarioSets,
} from '../src/diagnostics.js'
import {
  exportInspectRunRecord,
  exportLmEvaluationSummary,
} from '../src/interoperability.js'
import type { Dataset, RunRecord } from '../src/types.js'

const dataset: Dataset = {
  name: 'diagnostic-fixture',
  version: '1.0.0',
  scenarios: [
    {
      id: 's1',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: 'A unique prompt' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      meta: { outcomeType: 'tp', benchmarkTier: 'public', scenarioHash: 'hash:s1' },
    },
    {
      id: 's2',
      axes: ['quality'],
      input: { messages: [{ role: 'user', content: 'Another prompt' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
      meta: { outcomeType: 'tn', benchmarkTier: 'public', scenarioHash: 'hash:s2' },
    },
  ],
}

const record: RunRecord = {
  id: 'run-1',
  dataset: { name: 'diagnostic-fixture', version: '1.0.0' },
  runners: ['model:a', 'model:b'],
  createdAt: '2026-05-27T00:00:00.000Z',
  responses: [
    {
      runnerId: 'model:a',
      scenarioId: 's1',
      output: 'ok',
      meta: {
        provider: 'stub',
        model: 'a',
        accessedAt: '2026-05-27T00:00:00.000Z',
        latencyMs: 1,
      },
    },
  ],
  scores: [
    { runnerId: 'model:a', scenarioId: 's1', axis: 'quality', value: 1 },
    { runnerId: 'model:b', scenarioId: 's1', axis: 'quality', value: 0 },
    { runnerId: 'model:a', scenarioId: 's2', axis: 'quality', value: 1 },
    { runnerId: 'model:b', scenarioId: 's2', axis: 'quality', value: 1 },
  ],
  aggregates: [],
  meta: { harnessVersion: '0.4.0' },
}

describe('scenario diagnostics and interoperability exports', () => {
  it('reports item difficulty, outcome coverage, and leakage-like overlaps', () => {
    const report = analyseScenarioItems(dataset, record, {
      trainingPrompts: ['A unique prompt'],
    })

    expect(report.items.s1.passRate).toBe(0.5)
    expect(report.items.s2.passRate).toBe(1)
    expect(report.outcomeCoverage).toMatchObject({ tp: 1, tn: 1 })
    expect(report.flags).toContainEqual({
      scenarioId: 's1',
      kind: 'possible-leakage',
      detail: 'scenario prompt exactly matches a training prompt',
    })
  })

  it('compares scenario-set versions and flags changed or overlapping items', () => {
    const next: Dataset = {
      ...dataset,
      version: '1.1.0',
      scenarios: [
        dataset.scenarios[0],
        {
          ...dataset.scenarios[1],
          input: { messages: [{ role: 'user', content: 'Changed prompt' }] },
        },
        {
          id: 's3',
          axes: ['quality'],
          input: { messages: [{ role: 'user', content: 'A unique prompt' }] },
          rubric: { kind: 'programmatic', checker: 'non-empty' },
        },
      ],
    }

    const diff = compareScenarioSets(dataset, next)

    expect(diff.added).toEqual(['s3'])
    expect(diff.changed).toEqual(['s2'])
    expect(diff.suspiciousOverlaps).toEqual([
      { fromScenarioId: 's1', toScenarioId: 's3', reason: 'identical prompt text' },
    ])
  })

  it('exports run records into Inspect and lm-evaluation-harness friendly shapes', () => {
    const inspect = exportInspectRunRecord(record, dataset)
    expect(inspect.samples[0]).toMatchObject({
      id: 's1',
      input: 'A unique prompt',
      target: null,
      metadata: {
        scenarioHash: 'hash:s1',
        privacy: 'public',
      },
    })

    const summary = exportLmEvaluationSummary(record)
    expect(summary.results['diagnostic-fixture:model:a'].quality).toBe(1)
    expect(summary.versions.harness).toBe('0.4.0')
  })
})
