import { describe, expect, it } from 'vitest'

import {
  createLLMJudgeExecutor,
  parseLLMJudgeStructuredOutput,
} from '../src/llm-judge.js'
import type { ModelResponse, Scenario } from '../src/types.js'

const response: ModelResponse = {
  runnerId: 'stub:echo',
  scenarioId: 'judge-scenario',
  output: 'The bid should be blocked because the seller id is missing.',
  meta: {
    provider: 'stub',
    model: 'echo',
    accessedAt: '2026-06-25T00:00:00.000Z',
    latencyMs: 1,
  },
}

const scenario: Scenario = {
  id: 'judge-scenario',
  axes: ['judgement'],
  input: { messages: [{ role: 'user', content: 'Should this bid pass?' }] },
  rubric: {
    kind: 'llm-judge',
    judge: 'fixture:judge-v1',
    prompt: 'Score {response}',
    calibration: {
      setId: 'calibration/adtech-v1',
      minimumAgreement: 0.8,
      observedAgreement: 0.91,
      promptHash: 'sha256:judgeprompt',
    },
    biasChecks: [
      { kind: 'position', passed: true },
      { kind: 'verbosity', passed: true },
    ],
  },
}

describe('LLM judge executor', () => {
  it('parses structured judge JSON and attaches provenance', async () => {
    const executor = createLLMJudgeExecutor({
      adapter: async () => ({
        provider: 'fixture',
        model: 'judge-v1',
        text: '```json\n{"score":0.82,"rationale":"missing seller id is correctly flagged"}\n```',
      }),
      now: () => new Date('2026-06-25T12:00:00.000Z'),
      rubricVersion: 'rubric-v1',
    })

    const result = await executor({
      response,
      scenario,
      rubric: scenario.rubric.kind === 'llm-judge' ? scenario.rubric : neverRubric(),
      renderedPrompt: 'Score candidate output',
    })

    expect(result).toEqual({
      value: 0.82,
      rationale: 'missing seller id is correctly flagged',
      provenance: {
        provider: 'fixture',
        model: 'judge-v1',
        promptHash: 'sha256:judgeprompt',
        rubricVersion: 'rubric-v1',
        parserVersion: 'assay-llm-judge-json-v1',
        judgedAt: '2026-06-25T12:00:00.000Z',
      },
    })
  })

  it('rejects unstructured judge output', () => {
    expect(() => parseLLMJudgeStructuredOutput('looks good, 9/10')).toThrow(
      /structured judge JSON/,
    )
  })

  it('rejects judge JSON whose score is outside 0..1', () => {
    expect(() => parseLLMJudgeStructuredOutput('{"score":1.7,"rationale":"too high"}')).toThrow(
      /score.*0..1/,
    )
  })
})

function neverRubric(): never {
  throw new Error('expected llm-judge rubric')
}
