import { describe, expect, it } from 'vitest'

import {
  NEGATION_WINDOW_CHARS,
  containsUnnegatedMatch,
  literalPhrase,
  tokenPresent,
} from '../src/matchers.js'

describe('negation-aware word-edge matcher (assay-harness#54 Tier-1 #1)', () => {
  it('REGRESSION: the negated-TP string scores 0, not 1 (the keyword-bingo hole)', () => {
    // The exact adversarial case from the council finding: a TP item on
    // ["invalid traffic", "flag"] must NOT be credited for an answer that
    // negates both terms.
    const negated = 'this is NOT invalid traffic, do NOT flag'
    expect(containsUnnegatedMatch(negated, ['invalid traffic'])).toBe(false)
    expect(containsUnnegatedMatch(negated, ['flag'])).toBe(false)
  })

  it('credits the same terms when they are genuinely asserted', () => {
    const asserted = 'this is invalid traffic, you should flag the bid'
    expect(containsUnnegatedMatch(asserted, ['invalid traffic'])).toBe(true)
    expect(containsUnnegatedMatch(asserted, ['flag'])).toBe(true)
  })

  it('word-edge anchoring: "keep" does not leak into "keeper"', () => {
    expect(containsUnnegatedMatch('the goalkeeper saved it', ['keep'])).toBe(false)
    expect(containsUnnegatedMatch('we should keep the budget', ['keep'])).toBe(true)
  })

  it('clause boundary resets the window: a negation in an earlier clause does not suppress a later assertion', () => {
    const text = 'do not raise the floor. instead, flag the invalid traffic and block it.'
    expect(containsUnnegatedMatch(text, ['flag'])).toBe(true)
    expect(containsUnnegatedMatch(text, ['invalid traffic'])).toBe(true)
  })

  it('contrastive negation ("rather than", "instead of") suppresses the wrong alternative', () => {
    expect(containsUnnegatedMatch('use fractional rather than last-click', ['last-click'])).toBe(
      false,
    )
    expect(containsUnnegatedMatch('use fractional rather than last-click', ['fractional'])).toBe(
      true,
    )
  })

  it('"not only/just/merely" is NOT treated as a meaning-flip negation', () => {
    expect(containsUnnegatedMatch('not only is this invalid traffic, it repeats', ['invalid traffic'])).toBe(
      true,
    )
  })

  it('literalPhrase anchors alphanumeric phrases at word edges', () => {
    expect(literalPhrase('keep').test('keeper')).toBe(false)
    expect(literalPhrase('keep').test('please keep it')).toBe(true)
  })

  it('tokenPresent is negation-agnostic (used for bingo-echo detection)', () => {
    expect(tokenPresent('this is NOT invalid traffic', 'invalid traffic')).toBe(true)
  })

  it('the negation window constant is the governed value', () => {
    expect(NEGATION_WINDOW_CHARS).toBe(48)
  })
})
