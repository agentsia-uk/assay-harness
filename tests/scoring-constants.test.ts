import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ANTI_BINGO_CAP,
  FRONTIER_QUORUM_REQUIRED,
  FRONTIER_QUORUM_TOTAL,
  MECHANISM_GATE_WEIGHTS,
  MECHANISM_PASS_THRESHOLD,
  MECHANISM_SCORER_FINGERPRINT,
} from '../src/mechanism.js'
import { NEGATION_WINDOW_CHARS } from '../src/matchers.js'
import { PERSISTENCE_GRADER_FINGERPRINT } from '../src/persistence-grader.js'

/**
 * Governance (Rule-28) assertion of the three load-bearing scoring constants.
 * These pin the values so they cannot silently drift; each is derived in
 * docs/scoring-constants.md, and this test fails the build if a value moves
 * without that note moving with it. Council `assay-harness-review-2026-06-18`.
 */
describe('governed scoring constants (Rule-28)', () => {
  it('anti-bingo cap is 0.2, strictly below the pass threshold and above zero', () => {
    expect(ANTI_BINGO_CAP).toBe(0.2)
    expect(ANTI_BINGO_CAP).toBeLessThan(MECHANISM_PASS_THRESHOLD)
    expect(ANTI_BINGO_CAP).toBeGreaterThan(0)
  })

  it('negation window is 48 characters', () => {
    expect(NEGATION_WINDOW_CHARS).toBe(48)
  })

  it('frontier quorum is >=2 of 3 (a survivable simple majority)', () => {
    expect(FRONTIER_QUORUM_REQUIRED).toBe(2)
    expect(FRONTIER_QUORUM_TOTAL).toBe(3)
    expect(FRONTIER_QUORUM_REQUIRED).toBeGreaterThan(FRONTIER_QUORUM_TOTAL / 2)
    expect(FRONTIER_QUORUM_REQUIRED).toBeLessThan(FRONTIER_QUORUM_TOTAL)
  })

  it('mechanism gate weights are fingerprinted and remain load-bearing', () => {
    expect(MECHANISM_GATE_WEIGHTS).toEqual({
      quantitative: 0.45,
      disambiguation: 0.35,
      action: 0.2,
    })
    expect(MECHANISM_SCORER_FINGERPRINT.governedConstants.gateWeights).toEqual(
      MECHANISM_GATE_WEIGHTS,
    )
    expect(
      MECHANISM_GATE_WEIGHTS.quantitative +
        MECHANISM_GATE_WEIGHTS.disambiguation +
        MECHANISM_GATE_WEIGHTS.action,
    ).toBeCloseTo(1, 12)
  })

  it('persistence evidence validity predicate is fingerprinted', () => {
    expect(PERSISTENCE_GRADER_FINGERPRINT.governedConstants).toEqual({
      negationWindowChars: NEGATION_WINDOW_CHARS,
      emptyCriteriaScore: 0,
      passVerdict: 'pass',
    })
    expect(PERSISTENCE_GRADER_FINGERPRINT.evidenceValidityPredicate.id).toBe(
      'persistence-grader-v1-evidence-validity',
    )
    expect(PERSISTENCE_GRADER_FINGERPRINT.evidenceValidityPredicate.rules).toContain(
      'criteria-passed-must-equal-criteria-total',
    )
  })

  it('docs/scoring-constants.md documents each governed value (derivation present)', () => {
    const doc = readFileSync(resolve(__dirname, '..', 'docs', 'scoring-constants.md'), 'utf8')
    expect(doc).toMatch(/`0\.2`/)
    expect(doc).toMatch(/`0\.45`/)
    expect(doc).toMatch(/`0\.35`/)
    expect(doc).toMatch(/`48`/)
    expect(doc).toMatch(/2\/3/)
    expect(doc).toContain('mechanism-scorer-v1')
    expect(doc).toContain('persistence-grader-v1')
    expect(doc).toContain('persistence-grader-v1-evidence-validity')
    expect(doc.toLowerCase()).toContain('derivation')
  })
})
