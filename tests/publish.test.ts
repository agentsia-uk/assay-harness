import { describe, expect, it } from 'vitest'
import { buildMarkdownReport } from '../src/publish.js'
import type { RunRecord } from '../src/types.js'

function makeRecord(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'test-run-001',
    dataset: { name: 'my-dataset', version: '1.0.0' },
    runners: ['stub:echo'],
    createdAt: '2026-06-07T00:00:00.000Z',
    responses: [
      {
        runnerId: 'stub:echo',
        scenarioId: 'sc-1',
        output: 'hello',
        meta: { provider: 'stub', model: 'echo', accessedAt: '2026-06-07T00:00:00.000Z', latencyMs: 10 },
      },
    ],
    scores: [
      { runnerId: 'stub:echo', scenarioId: 'sc-1', axis: 'quality', value: 0.8 },
    ],
    aggregates: [
      {
        runnerId: 'stub:echo',
        axes: { quality: { mean: 0.8, variance: 0, n: 1 } },
        composite: 0.8,
        weights: { quality: 1 },
      },
    ],
    meta: { harnessVersion: '0.4.0' },
    ...partial,
  }
}

describe('buildMarkdownReport', () => {
  it('includes the run id and dataset name', () => {
    const md = buildMarkdownReport(makeRecord())
    expect(md).toContain('test-run-001')
    expect(md).toContain('my-dataset')
    expect(md).toContain('1.0.0')
  })

  it('includes composite score table', () => {
    const md = buildMarkdownReport(makeRecord())
    expect(md).toContain('Composite scores')
    expect(md).toContain('stub:echo')
    expect(md).toContain('0.8000')
  })

  it('includes per-axis table when axes are present', () => {
    const md = buildMarkdownReport(makeRecord())
    expect(md).toContain('Per-axis means')
    expect(md).toContain('quality')
  })

  it('includes response and score counts', () => {
    const md = buildMarkdownReport(makeRecord())
    expect(md).toContain('1 scores')
    expect(md).toContain('1 responses')
  })

  it('handles a record with no aggregates gracefully', () => {
    const md = buildMarkdownReport(makeRecord({ aggregates: [] }))
    expect(md).toContain('test-run-001')
    expect(md).not.toContain('Composite scores')
  })
})
