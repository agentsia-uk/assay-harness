import { describe, expect, it } from 'vitest'

import {
  score,
  validateHumanAnnotations,
  annotationsToPreferencePairs,
} from '../src/rubric.js'
import type {
  HumanAnnotation,
  LLMJudgeExecutor,
  ModelResponse,
  Scenario,
} from '../src/types.js'

const response: ModelResponse = {
  runnerId: 'model:a',
  scenarioId: 'scenario-1',
  output: 'The bid should be blocked because the seller id is missing.',
  meta: {
    provider: 'stub',
    model: 'deterministic',
    accessedAt: '2026-05-27T00:00:00.000Z',
    latencyMs: 1,
  },
}

describe('calibrated rubric executors', () => {
  it('scores an llm-judge rubric only when calibration and provenance are explicit', async () => {
    const scenario: Scenario = {
      id: 'scenario-1',
      axes: ['judgement'],
      input: { messages: [{ role: 'user', content: 'Should this bid pass?' }] },
      rubric: {
        kind: 'llm-judge',
        judge: 'stub:judge',
        prompt: 'Score {response}',
        calibration: {
          setId: 'calibration/adtech-v1',
          minimumAgreement: 0.8,
          observedAgreement: 0.9,
          promptHash: 'sha256:abc',
        },
        biasChecks: [
          { kind: 'verbosity', passed: true },
          { kind: 'position', passed: true },
        ],
      },
    }
    const judge: LLMJudgeExecutor = async () => ({
      value: 0.75,
      rationale: 'detected the missing seller id',
      provenance: {
        provider: 'stub',
        model: 'judge',
        promptHash: 'sha256:abc',
        rubricVersion: 'v1',
        parserVersion: 'parser-v1',
        judgedAt: '2026-05-27T00:00:00.000Z',
      },
    })

    const scores = await score(response, scenario, { llmJudge: judge })

    expect(scores[0].value).toBe(0.75)
    expect(scores[0].judge).toBe('stub:judge')
    expect(scores[0].judgeProvenance?.promptHash).toBe('sha256:abc')
    expect(scores[0].claimStatus).toBe('analysis-only')
  })

  it('blocks llm-judge scoring when calibration agreement is below threshold', async () => {
    const scenario: Scenario = {
      id: 'scenario-1',
      axes: ['judgement'],
      input: { messages: [{ role: 'user', content: 'Should this bid pass?' }] },
      rubric: {
        kind: 'llm-judge',
        judge: 'stub:judge',
        prompt: 'Score {response}',
        calibration: {
          setId: 'calibration/adtech-v1',
          minimumAgreement: 0.8,
          observedAgreement: 0.5,
          promptHash: 'sha256:abc',
        },
      },
    }

    expect(() => score(response, scenario, { llmJudge: async () => ({ value: 1 }) }))
      .toThrow(/calibration/)
  })

  it('validates human annotations, adjudicates conflicts, and exports preference pairs', () => {
    const annotations: HumanAnnotation[] = [
      {
        itemId: 'item-1',
        scenarioHash: 'scenario:1',
        responseId: 'a',
        label: 'pass',
        score: 1,
        reviewer: 'reviewer-a',
        rubricVersion: 'rubric-v1',
        annotatedAt: '2026-05-27T00:00:00.000Z',
        status: 'agreed',
      },
      {
        itemId: 'item-1',
        scenarioHash: 'scenario:1',
        responseId: 'b',
        label: 'fail',
        score: 0,
        reviewer: 'reviewer-b',
        rubricVersion: 'rubric-v1',
        annotatedAt: '2026-05-27T00:00:01.000Z',
        status: 'agreed',
      },
    ]

    const report = validateHumanAnnotations(annotations)
    expect(report.valid).toBe(true)
    expect(report.conflicts).toHaveLength(0)

    expect(annotationsToPreferencePairs(annotations)).toEqual([
      {
        itemId: 'item-1',
        scenarioHash: 'scenario:1',
        chosenResponseId: 'a',
        rejectedResponseId: 'b',
        source: 'human-annotation',
        rubricVersion: 'rubric-v1',
      },
    ])
  })
})
