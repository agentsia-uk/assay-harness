import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * Deterministic stub runner. Echoes the last user message as its output.
 * Used for testing and for the smoke harness run. Not a real model.
 */
export function createStubRunner(kind: 'echo' | 'empty' = 'echo'): Runner {
  const id = `stub:${kind}`
  return {
    id,
    provider: 'stub',
    model: kind,
    async run(scenario: Scenario, opts: RunnerOptions = {}): Promise<ModelResponse> {
      const started = Date.now()
      const lastUser = [...scenario.input.messages].reverse().find((m) => m.role === 'user')
      const output = kind === 'empty' ? '' : (lastUser?.content ?? '')
      const response: ModelResponse = {
        runnerId: id,
        scenarioId: scenario.id,
        output,
        meta: {
          provider: 'stub',
          model: kind,
          version: '0',
          accessedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
        },
      }
      if (opts.temperature !== undefined) response.meta.temperature = opts.temperature
      if (opts.seed !== undefined) response.meta.seed = opts.seed
      return response
    },
  }
}
