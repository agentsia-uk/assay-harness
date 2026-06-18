import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ANTI_BINGO_CAP,
  FRONTIER_QUORUM_REQUIRED,
  FRONTIER_QUORUM_TOTAL,
  MECHANISM_PASS_THRESHOLD,
} from '../src/mechanism.js'
import { NEGATION_WINDOW_CHARS } from '../src/matchers.js'

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

  it('docs/scoring-constants.md documents each governed value (derivation present)', () => {
    const doc = readFileSync(resolve(__dirname, '..', 'docs', 'scoring-constants.md'), 'utf8')
    expect(doc).toMatch(/`0\.2`/)
    expect(doc).toMatch(/`48`/)
    expect(doc).toMatch(/2\/3/)
    expect(doc.toLowerCase()).toContain('derivation')
  })
})
