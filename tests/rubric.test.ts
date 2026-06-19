import { describe, expect, it } from 'vitest'

import { ANTI_BINGO_CAP } from '../src/mechanism.js'
import { score } from '../src/rubric.js'
import type { ModelResponse, Scenario } from '../src/types.js'

function response(output: string): ModelResponse {
  return {
    runnerId: 'stub:test',
    scenarioId: 'scenario-1',
    output,
    meta: {
      provider: 'stub',
      model: 'test',
      accessedAt: '2026-06-19T00:00:00.000Z',
      latencyMs: 1,
    },
  }
}

function scenario(checker: string, params: Record<string, unknown>): Scenario {
  return {
    id: 'scenario-1',
    axes: ['quality'],
    input: { messages: [{ role: 'user', content: 'classify this bid' }] },
    rubric: { kind: 'programmatic', checker, params },
  }
}

describe('programmatic rubric scoring', () => {
  it('caps non-smoke contains so negated keyword bingo cannot receive full credit', () => {
    const [result] = score(
      response('this is NOT invalid traffic, do NOT flag'),
      scenario('contains', { expected: ['invalid traffic', 'flag'] }),
    )

    expect(result.value).toBe(ANTI_BINGO_CAP)
    expect(result.value).toBeLessThan(1)
    expect(result.rationale).toContain('contains capped')
  })

  it('keeps explicit smoke-test contains behavior available for harness fixtures', () => {
    const [result] = score(
      response('this is NOT invalid traffic, do NOT flag'),
      scenario('contains', { expected: ['invalid traffic', 'flag'], smokeTestOnly: true }),
    )

    expect(result.value).toBe(1)
    expect(result.rationale).toContain('smoke-test-only')
  })

  it('scores the keyword checker with negation-aware word-edge matching', () => {
    const [negated] = score(
      response('this is NOT invalid traffic, do NOT flag'),
      scenario('keyword', { expected: ['invalid traffic', 'flag'] }),
    )
    const [asserted] = score(
      response('this is invalid traffic, you should flag it'),
      scenario('keyword', { expected: ['invalid traffic', 'flag'] }),
    )

    expect(negated.value).toBe(0)
    expect(asserted.value).toBe(1)
  })
})
