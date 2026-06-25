import { describe, expect, it } from 'vitest'

import { aggregate } from '../src/aggregator.js'
import {
  defaultEnvironmentRedactor,
  environmentResultToModelResponse,
  isEnvironmentScenario,
  runEnvironmentScenario,
  scoreEnvironmentResult,
  type EnvironmentAdapter,
} from '../src/environment.js'
import { validateRunRecord } from '../src/validate.js'
import type {
  EnvironmentScenario,
  EnvironmentStateValidationResult,
  ModelResponse,
  RunRecord,
  Runner,
  Scenario,
} from '../src/types.js'

interface CounterState {
  count: number
  ownerSecret: string
}

function scriptedRunner(outputs: string[]): Runner & { seen: Scenario[] } {
  const seen: Scenario[] = []
  let i = 0
  return {
    id: 'stub:scripted-env',
    provider: 'stub',
    model: 'scripted-env',
    seen,
    async run(scenario: Scenario): Promise<ModelResponse> {
      seen.push(scenario)
      const output = outputs[i] ?? ''
      i += 1
      return {
        runnerId: 'stub:scripted-env',
        scenarioId: scenario.id,
        output,
        meta: {
          provider: 'stub',
          model: 'scripted-env',
          accessedAt: new Date().toISOString(),
          latencyMs: 0,
        },
      }
    },
  }
}

const counterEnvironment: EnvironmentAdapter<CounterState> = {
  id: 'fixture:counter',
  version: '1',
  setup(setup) {
    const input = setup as { initial?: number, ownerSecret?: string } | undefined
    return {
      count: input?.initial ?? 0,
      ownerSecret: input?.ownerSecret ?? 'sk-fixture-secret',
    }
  },
  parseAction(response) {
    const parsed = JSON.parse(response.output) as { tool: string, input?: unknown }
    return {
      toolName: parsed.tool,
      input: parsed.input,
      raw: parsed,
    }
  },
  applyAction(state, action) {
    if (action.toolName !== 'counter.add') {
      return {
        state,
        observation: {
          ok: false,
          error: {
            code: 'unknown-tool',
            message: `unknown fixture tool ${action.toolName}`,
          },
        },
      }
    }

    const input = action.input as { amount?: number } | undefined
    const amount = input?.amount ?? 0
    const next = { ...state, count: state.count + amount }
    return {
      state: next,
      observation: {
        ok: true,
        output: {
          count: next.count,
          ownerSecret: next.ownerSecret,
        },
      },
    }
  },
  validators: {
    'count-equals': (state, params): EnvironmentStateValidationResult => {
      const expected = typeof params?.['expected'] === 'number' ? params.expected : undefined
      const passed = state.count === expected
      return {
        id: 'count-equals',
        passed,
        value: passed ? 1 : 0,
        rationale: `count=${state.count}, expected=${String(expected)}`,
      }
    },
  },
  serializeState(state) {
    return state
  },
  renderObservation(observation) {
    return {
      role: 'user',
      content: `Observation: ${JSON.stringify(observation)}`,
    }
  },
}

function counterScenario(partial: Partial<EnvironmentScenario> = {}): EnvironmentScenario {
  return {
    id: 'counter-reaches-five',
    axes: ['stateful-tools'],
    input: {
      messages: [
        {
          role: 'user',
          content: 'Use the counter.add tool until the counter reaches five.',
        },
      ],
    },
    rubric: { kind: 'programmatic', checker: 'non-empty' },
    environment: {
      environmentId: 'fixture:counter',
      setup: {
        initial: 0,
        ownerSecret: 'sk-setup-secret',
      },
      maxSteps: 2,
      toolPolicy: {
        allowedToolNames: ['counter.add'],
        maxCalls: 2,
      },
      validators: [
        {
          id: 'count-equals',
          params: { expected: 5 },
        },
      ],
    },
    ...partial,
  }
}

describe('environment runner bridge', () => {
  it('executes a deterministic fixture environment and validates final state', async () => {
    const runner = scriptedRunner([
      JSON.stringify({
        tool: 'counter.add',
        input: { amount: 2, apiKey: 'sk-action-secret' },
      }),
      JSON.stringify({ tool: 'counter.add', input: { amount: 3 } }),
    ])

    const result = await runEnvironmentScenario(runner, counterScenario(), {
      adapter: counterEnvironment,
    })

    expect(result.value).toBe(1)
    expect(result.finalState).toEqual({
      count: 5,
      ownerSecret: 'sk-setup-secret',
    })
    expect(result.validations).toEqual([
      expect.objectContaining({
        id: 'count-equals',
        passed: true,
        value: 1,
      }),
    ])
    expect(result.trace.steps).toHaveLength(2)
    expect(runner.seen[1]?.input.messages.at(-1)?.content).toContain('Observation:')
  })

  it('records a serializable public trace with setup, actions, observations, final state, and redaction', async () => {
    const runner = scriptedRunner([
      JSON.stringify({
        tool: 'counter.add',
        input: { amount: 5, apiKey: 'sk-action-secret' },
      }),
    ])

    const result = await runEnvironmentScenario(
      runner,
      counterScenario({
        environment: {
          ...counterScenario().environment,
          maxSteps: 1,
          toolPolicy: { allowedToolNames: ['counter.add'], maxCalls: 1 },
        },
      }),
      {
        adapter: counterEnvironment,
        redact: defaultEnvironmentRedactor,
      },
    )

    expect(() => JSON.stringify(result.trace)).not.toThrow()
    expect(result.trace.schemaVersion).toBe('assay.environment-trace.v1')
    expect(result.trace.setup).toEqual({
      initial: 0,
      ownerSecret: '[REDACTED]',
    })
    expect(result.trace.steps[0]?.action?.input).toEqual({
      amount: 5,
      apiKey: '[REDACTED]',
    })
    expect(result.trace.steps[0]?.observation.output).toEqual({
      count: 5,
      ownerSecret: '[REDACTED]',
    })
    expect(result.trace.finalState).toEqual({
      count: 5,
      ownerSecret: '[REDACTED]',
    })
    expect(result.trace.redaction.redactedPaths).toEqual(
      expect.arrayContaining([
        'setup.ownerSecret',
        'steps[0].action.input.apiKey',
        'steps[0].observation.output.ownerSecret',
        'finalState.ownerSecret',
      ]),
    )
  })

  it('fails closed when a model calls a tool outside scenario policy', async () => {
    const runner = scriptedRunner([
      JSON.stringify({ tool: 'counter.reset', input: { reason: 'try to cheat' } }),
    ])

    const result = await runEnvironmentScenario(runner, counterScenario(), {
      adapter: counterEnvironment,
    })

    expect(result.value).toBe(0)
    expect(result.finalState.count).toBe(0)
    expect(result.trace.steps).toHaveLength(1)
    expect(result.trace.steps[0]?.observation).toMatchObject({
      ok: false,
      error: {
        code: 'tool-policy-violation',
      },
    })
    expect(result.validations[0]).toMatchObject({
      id: 'count-equals',
      passed: false,
      value: 0,
    })
  })

  it('collapses environment execution into RunRecord-compatible response and scores', async () => {
    const runner = scriptedRunner([
      JSON.stringify({ tool: 'counter.add', input: { amount: 5 } }),
    ])
    const scenario = counterScenario({
      environment: {
        ...counterScenario().environment,
        maxSteps: 1,
        toolPolicy: { allowedToolNames: ['counter.add'], maxCalls: 1 },
      },
    })
    const result = await runEnvironmentScenario(runner, scenario, {
      adapter: counterEnvironment,
    })
    const response = environmentResultToModelResponse(result)
    const scores = scoreEnvironmentResult(result, scenario)
    const aggregates = aggregate(scores)
    const record: RunRecord = {
      id: 'environment-fixture-run',
      dataset: { name: 'fixture', version: '0.0.0' },
      runners: [runner.id],
      createdAt: new Date().toISOString(),
      responses: [response],
      scores,
      aggregates,
      meta: {
        harnessVersion: '0.0.0-test',
        environment: {
          schemaVersion: 'assay.environment-run-metadata.v1',
          results: [result.trace],
        },
      },
    }

    expect(response.scenarioId).toBe(scenario.id)
    expect(response.meta.extra?.['environment']).toEqual({
      environmentId: 'fixture:counter',
      traceSchemaVersion: 'assay.environment-trace.v1',
      validatorCount: 1,
      passedValidatorCount: 1,
    })
    expect(scores).toEqual([
      expect.objectContaining({
        runnerId: runner.id,
        scenarioId: scenario.id,
        axis: 'stateful-tools',
        value: 1,
        claimStatus: 'programmatic',
      }),
    ])
    expect(validateRunRecord(record)).toEqual({ valid: true, errors: [] })
  })

  it('does not mark ordinary single-turn scenarios as environment-backed', () => {
    const scenario: Scenario = {
      id: 'ordinary',
      axes: ['echo'],
      input: { messages: [{ role: 'user', content: 'hello' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
    }

    expect(isEnvironmentScenario(scenario)).toBe(false)
  })
})
