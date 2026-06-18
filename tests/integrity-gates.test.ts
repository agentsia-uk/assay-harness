/**
 * Integrity gates — Tier-1 #2/#3/#4 (council `assay-harness-review-2026-06-18`,
 * epic agentsia-uk/assay-harness#54).
 *
 *   #2  scenario-set-hash binding + refuse-on-mismatch + corpus-identity
 *       uniqueness (a version tag pins a unique (count, hash)).
 *   #3  bootstrap confidence intervals wired into the aggregate path.
 *   #4  stratification publication guard fails closed on missing/imbalanced
 *       outcome-type coverage.
 */

import { describe, expect, it } from 'vitest'

import type { Dataset, Score } from '../src/types.js'
import { computeScenarioSetHash } from '../src/serialiser.js'
import { aggregate } from '../src/aggregator.js'
import {
  assertScenarioSetHashMatches,
  assertScenarioStratificationPublishable,
  ScenarioSetHashMismatchError,
  ScenarioStratificationPublicationError,
} from '../src/validate.js'

function scenario(id: string, outcomeType?: string) {
  return {
    id,
    axes: ['accuracy'],
    input: { messages: [{ role: 'user' as const, content: `prompt for ${id}` }] },
    rubric: { kind: 'programmatic' as const, checker: 'exact-match' },
    ...(outcomeType ? { meta: { outcomeType } } : {}),
  }
}

function dataset(ids: string[]): Dataset {
  return { name: 'assay-adtech', version: '1.8.0-rc.4', scenarios: ids.map((id) => scenario(id)) }
}

describe('Tier-1 #2 — scenario-set hash binding', () => {
  it('is deterministic and order-independent', () => {
    const a = dataset(['s1', 's2', 's3'])
    const b = dataset(['s3', 's1', 's2'])
    expect(computeScenarioSetHash(a)).toBe(computeScenarioSetHash(b))
  })

  it('changes when the scenario set changes', () => {
    const base = computeScenarioSetHash(dataset(['s1', 's2']))
    const extra = computeScenarioSetHash(dataset(['s1', 's2', 's3']))
    expect(base).not.toBe(extra)
  })

  it('ignores cosmetic meta but reacts to prompt/rubric edits', () => {
    const ds = dataset(['s1'])
    const withNote: Dataset = {
      ...ds,
      scenarios: [{ ...ds.scenarios[0]!, meta: { note: 'cosmetic' } }],
    }
    expect(computeScenarioSetHash(withNote)).toBe(computeScenarioSetHash(ds))

    const editedPrompt: Dataset = {
      ...ds,
      scenarios: [
        { ...ds.scenarios[0]!, input: { messages: [{ role: 'user', content: 'CHANGED' }] } },
      ],
    }
    expect(computeScenarioSetHash(editedPrompt)).not.toBe(computeScenarioSetHash(ds))
  })

  it('matches when the corpus equals the declared contract hash', () => {
    const ds = dataset(['s1', 's2'])
    const declared = computeScenarioSetHash(ds)
    expect(assertScenarioSetHashMatches(ds, declared)).toBe(declared)
  })

  it('refuses to score a corpus that does not match the declared hash', () => {
    const declared = computeScenarioSetHash(dataset(['s1', 's2']))
    const different = dataset(['s1', 's2', 's3'])
    expect(() => assertScenarioSetHashMatches(different, declared)).toThrow(
      ScenarioSetHashMismatchError,
    )
    try {
      assertScenarioSetHashMatches(different, declared)
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioSetHashMismatchError)
      expect((error as ScenarioSetHashMismatchError).expected).toBe(declared)
      expect((error as Error).message).toContain('refuses to')
    }
  })
})

describe('Tier-1 #3 — bootstrap confidence intervals in the aggregate path', () => {
  const scores: Score[] = [
    { runnerId: 'r1', scenarioId: 's1', axis: 'accuracy', value: 0.8 },
    { runnerId: 'r1', scenarioId: 's2', axis: 'accuracy', value: 0.6 },
    { runnerId: 'r1', scenarioId: 's3', axis: 'accuracy', value: 0.9 },
  ]

  it('omits intervals when no confidence config is supplied', () => {
    const [agg] = aggregate(scores)
    expect(agg!.axes['accuracy']!.confidenceInterval).toBeUndefined()
    expect(agg!.statisticalClaims).toBeUndefined()
  })

  it('emits seeded, reproducible intervals when wired in', () => {
    const opts = {
      confidence: { method: 'bootstrap' as const, iterations: 500, confidenceLevel: 0.95, seed: 7 },
    }
    const [first] = aggregate(scores, opts)
    const [second] = aggregate(scores, opts)
    const ci = first!.axes['accuracy']!.confidenceInterval
    expect(ci).toBeDefined()
    expect(ci!.method).toBe('bootstrap')
    expect(ci!.lower).toBeLessThanOrEqual(ci!.upper)
    expect(ci!.seed).toBe(7)
    // reproducible under the same seed
    expect(second!.axes['accuracy']!.confidenceInterval).toEqual(ci)
    expect(first!.statisticalClaims).toMatchObject({ method: 'bootstrap', seed: 7 })
  })
})

describe('Tier-1 #4 — stratification publication guard', () => {
  const balanced = { tp: 10, tn: 10, 'fp-guard': 10, 'fn-guard': 10 }

  it('passes when every outcome type is present and balanced', () => {
    expect(() => assertScenarioStratificationPublishable(balanced)).not.toThrow()
  })

  it('fails closed when an outcome type is missing', () => {
    const missing = { tp: 10, tn: 10, 'fp-guard': 10 }
    expect(() => assertScenarioStratificationPublishable(missing)).toThrow(
      ScenarioStratificationPublicationError,
    )
    try {
      assertScenarioStratificationPublishable(missing)
    } catch (error) {
      expect((error as ScenarioStratificationPublicationError).reasons.join(' ')).toContain(
        'fn-guard',
      )
    }
  })

  it('fails closed when an outcome type is too imbalanced', () => {
    const imbalanced = { tp: 100, tn: 100, 'fp-guard': 100, 'fn-guard': 1 }
    expect(() => assertScenarioStratificationPublishable(imbalanced)).toThrow(
      ScenarioStratificationPublicationError,
    )
  })

  it('fails closed when no recognised outcome type is present at all', () => {
    expect(() => assertScenarioStratificationPublishable({})).toThrow(
      ScenarioStratificationPublicationError,
    )
  })

  it('honours a custom minimum-share floor', () => {
    const slightlyThin = { tp: 100, tn: 100, 'fp-guard': 100, 'fn-guard': 20 }
    // 20/320 = 6.25% — passes the default 5% floor but fails a 10% floor.
    expect(() => assertScenarioStratificationPublishable(slightlyThin)).not.toThrow()
    expect(() =>
      assertScenarioStratificationPublishable(slightlyThin, { minShare: 0.1 }),
    ).toThrow(ScenarioStratificationPublicationError)
  })
})
