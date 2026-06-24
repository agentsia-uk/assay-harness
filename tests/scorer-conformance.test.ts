import { describe, expect, it } from 'vitest'

import {
  MECHANISM_SCORER_FINGERPRINT,
  coerceCriteria,
  scoreMechanism,
  type MechanismCriteria,
} from '../src/mechanism.js'
import {
  PERSISTENCE_GRADER_FINGERPRINT,
  evaluatePersistenceEvidenceValidity,
  gradePersistence,
  isPersistenceEvidenceValid,
  type PersistenceCriterion,
  type PersistenceEvidenceReference,
  type PersistenceEvidenceValidityOptions,
  type TurnObservation,
} from '../src/persistence-grader.js'

import conformance from './fixtures/scorer-conformance/modelsmith-exported-public-expectations.json'

describe('public scorer conformance fingerprints', () => {
  it('matches the Modelsmith-exported public-safe mechanism fingerprint', () => {
    expect(MECHANISM_SCORER_FINGERPRINT).toEqual(conformance.fingerprints.mechanism)
  })

  it('matches the Modelsmith-exported public-safe persistence fingerprint', () => {
    expect(PERSISTENCE_GRADER_FINGERPRINT).toEqual(conformance.fingerprints.persistence)
  })
})

describe('public scorer conformance fixtures', () => {
  it('keeps mechanism scoring aligned with exported public expectations', () => {
    for (const testcase of conformance.mechanismCases) {
      const result = scoreMechanism(
        testcase.text,
        coerceCriteria(testcase.criteria) as MechanismCriteria,
      )
      expect(result.value, testcase.id).toBeCloseTo(testcase.expected.value, 9)
      expect(result.passed, testcase.id).toBe(testcase.expected.passed)
      expect(result.bingoGuardTripped, testcase.id).toBe(
        testcase.expected.bingoGuardTripped,
      )
    }
  })

  it('keeps persistence grading aligned with exported public expectations', () => {
    for (const testcase of conformance.persistenceCases) {
      const result = gradePersistence(
        testcase.turns as TurnObservation[],
        testcase.criterion as PersistenceCriterion,
      )
      expect(result.verdict, testcase.id).toBe(testcase.expected.verdict)
      expect(result.reason, testcase.id).toBe(testcase.expected.reason)
    }
  })
})

describe('persistence-grader-v1 evidence validity predicate', () => {
  it('evaluates trace-backed evidence references using the public predicate', () => {
    for (const testcase of conformance.persistenceEvidenceCases) {
      const evidence = testcase.evidence as PersistenceEvidenceReference
      const options = testcase.options as PersistenceEvidenceValidityOptions
      const result = evaluatePersistenceEvidenceValidity(evidence, options)
      expect(result.valid, testcase.id).toBe(testcase.expected.valid)
      expect(result.reason, testcase.id).toBe(testcase.expected.reason)
      expect(isPersistenceEvidenceValid(evidence, options), testcase.id).toBe(
        testcase.expected.valid,
      )
    }
  })
})
