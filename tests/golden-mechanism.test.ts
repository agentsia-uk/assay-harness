import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { aggregate } from '../src/aggregator.js'
import { score } from '../src/rubric.js'
import type { ModelResponse, Scenario, Score } from '../src/types.js'

/**
 * Golden reproducibility self-test (assay-harness#54, council
 * `assay-harness-review-2026-06-18`, "keep regardless"). A pinned mini-corpus of
 * ADTECH-shaped mechanism scenarios + pinned model outputs is run through the
 * REAL scorer (score + aggregate) and the regenerated composite is asserted
 * against a pinned value. This is the only check that proves the headline
 * anti-bingo mechanism scoring is reproducible: change the scorer and this
 * fixture's composites move, failing CI.
 *
 * The fixture carries public scoring RULES only (gate matchers), never a private
 * answer-key field — exposing the rule is not exposing the answer.
 */

interface GoldenCorpus {
  name: string
  version: string
  scenarios: Scenario[]
  outputs: Record<string, Record<string, string>>
  expectedComposites: Record<string, number>
}

const TOLERANCE = 1e-9

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures', 'golden-mechanism', 'corpus.json'), 'utf8'),
) as GoldenCorpus

describe('golden mechanism reproducibility self-test', () => {
  it('regenerates each pinned composite within tolerance', () => {
    for (const [runnerId, byScenario] of Object.entries(corpus.outputs)) {
      const scores = corpus.scenarios.flatMap((scenario) => {
        const output = byScenario[scenario.id]
        if (output === undefined) {
          throw new Error(`golden: missing pinned output for ${runnerId}/${scenario.id}`)
        }
        const response: ModelResponse = {
          runnerId,
          scenarioId: scenario.id,
          output,
          meta: {
            provider: 'golden',
            model: runnerId,
            accessedAt: '2026-06-19T00:00:00.000Z',
            latencyMs: 0,
          },
        }
        return score(response, scenario) as Score[]
      })

      const aggregates = aggregate(scores)
      const agg = aggregates.find((a) => a.runnerId === runnerId)
      expect(agg, `aggregate present for ${runnerId}`).toBeDefined()
      const expected = corpus.expectedComposites[runnerId]
      expect(
        Math.abs((agg?.composite ?? NaN) - expected),
        `${runnerId} composite ${agg?.composite} != pinned ${expected}`,
      ).toBeLessThan(TOLERANCE)
    }
  })

  it('the strong model out-ranks the keyword-bingo model (anti-bingo holds end-to-end)', () => {
    expect(corpus.expectedComposites['model:strong']).toBeGreaterThan(
      corpus.expectedComposites['model:bingo'],
    )
    // The bingo model must sit at or below the anti-bingo cap, not get a free pass.
    expect(corpus.expectedComposites['model:bingo']).toBeLessThanOrEqual(0.2)
  })
})
