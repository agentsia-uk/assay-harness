import { describe, expect, it } from 'vitest'

import {
  ANTI_BINGO_CAP,
  type MechanismCriteria,
  scoreMechanism,
} from '../src/mechanism.js'
import { score } from '../src/rubric.js'
import type { MechanismRubric, ModelResponse, Scenario } from '../src/types.js'

const criteria: MechanismCriteria = {
  quantitative: [{ label: 'split-65-35', matchers: [/0\.65/, /65%/] }],
  disambiguation: [
    {
      label: 'rejects-last-click',
      matchers: [/distinct from last[- ]click/, /rather than last[- ]click/, /not last[- ]click/],
    },
  ],
  actions: [{ label: 'request-lift-study', matchers: [/(lift study|holdout|incrementality test)/] }],
  bingoTokens: [/attribution/, /fractional/],
}

describe('mechanism scorer (assay-harness#54 Tier-2 #5)', () => {
  it('anti-bingo: vocabulary-only echo is capped at 0.2 and fails', () => {
    const r = scoreMechanism('we recommend fractional attribution.', criteria)
    expect(r.bingoGuardTripped).toBe(true)
    expect(r.value).toBe(0.2)
    expect(r.value).toBe(ANTI_BINGO_CAP)
    expect(r.passed).toBe(false)
  })

  it('genuine mechanism reasoning (quant + disambig + action) scores high and passes', () => {
    const r = scoreMechanism(
      'apply the 65% video / 35% search split. this is distinct from last-click attribution. request a lift study.',
      criteria,
    )
    expect(r.value).toBeCloseTo(1, 5)
    expect(r.passed).toBe(true)
  })

  it('partial (quantitative only) earns partial credit but does not reach 0.5', () => {
    const r = scoreMechanism('we suggest 0.65 weighting for video and fractional attribution.', criteria)
    expect(r.value).toBeCloseTo(0.45, 5)
    expect(r.passed).toBe(false)
  })

  it('a negated alternative in an earlier clause does not suppress a later correct mechanism', () => {
    const r = scoreMechanism(
      'rather than last-click, use the 65% video / 35% search split and request a holdout lift study.',
      criteria,
    )
    expect(r.passed).toBe(true)
    expect(r.rationale).toContain('quant=1/1')
    expect(r.rationale).toContain('disambig=1/1')
  })

  it('wired into score() as a mechanism rubric kind', () => {
    const rubric: MechanismRubric = {
      kind: 'mechanism',
      quantitative: [{ label: 'split', matchers: ['/0\\.65/', '65%'] }],
      disambiguation: [{ label: 'reject-lc', matchers: ['/distinct from last[- ]click/'] }],
      actions: [{ label: 'lift', matchers: ['/lift study/'] }],
      bingoTokens: ['attribution', 'fractional'],
    }
    const scenario: Scenario = {
      id: 'mech-1',
      axes: ['mechanism'],
      input: { messages: [{ role: 'user', content: 'analyse' }] },
      rubric,
    }
    const goodResponse: ModelResponse = {
      runnerId: 'model:x',
      scenarioId: 'mech-1',
      output:
        'apply the 65% video / 35% search split, distinct from last-click attribution, and run a lift study.',
      meta: { provider: 'stub', model: 'd', accessedAt: '2026-06-19T00:00:00.000Z', latencyMs: 1 },
    }
    const goodScores = score(goodResponse, scenario) as Array<{ value: number; claimStatus?: string }>
    expect(goodScores[0].value).toBeCloseTo(1, 5)
    expect(goodScores[0].claimStatus).toBe('programmatic')

    const bingoResponse: ModelResponse = {
      ...goodResponse,
      output: 'we recommend fractional attribution.',
    }
    const bingoScores = score(bingoResponse, scenario) as Array<{ value: number }>
    expect(bingoScores[0].value).toBe(0.2)
  })
})
