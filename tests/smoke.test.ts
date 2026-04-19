import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

import { loadDataset } from '../src/loader.js'
import { resolveRunner } from '../src/runners/index.js'
import { score } from '../src/rubric.js'
import { aggregate } from '../src/aggregator.js'

const EXAMPLES = resolve(__dirname, '..', 'examples', 'scenarios')

describe('smoke', () => {
  it('loads the example dataset', async () => {
    const dataset = await loadDataset(EXAMPLES)
    expect(dataset.scenarios.length).toBeGreaterThan(0)
    for (const s of dataset.scenarios) {
      expect(s.id).toBeTruthy()
      expect(s.axes.length).toBeGreaterThan(0)
      expect(s.input.messages.length).toBeGreaterThan(0)
    }
  })

  it('runs the stub:echo runner end to end', async () => {
    const dataset = await loadDataset(EXAMPLES)
    const runner = resolveRunner('stub:echo')

    const scores = []
    for (const scenario of dataset.scenarios) {
      const response = await runner.run(scenario)
      expect(response.runnerId).toBe('stub:echo')
      expect(response.scenarioId).toBe(scenario.id)
      expect(response.meta.provider).toBe('stub')
      expect(typeof response.meta.latencyMs).toBe('number')
      scores.push(...score(response, scenario))
    }

    const aggregates = aggregate(scores)
    expect(aggregates.length).toBe(1)
    expect(aggregates[0].runnerId).toBe('stub:echo')
    expect(aggregates[0].composite).toBeGreaterThanOrEqual(0)
    expect(aggregates[0].composite).toBeLessThanOrEqual(1)
  })

  it('rejects an unknown provider', () => {
    expect(() => resolveRunner('madeup:foo')).toThrow(/unknown provider/)
  })
})
