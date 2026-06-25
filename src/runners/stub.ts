import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'
import {
  buildRuntimeMetadata,
  prepareRunnerRuntime,
  withRunnerTimeout,
} from './runtime.js'

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
      const runtime = prepareRunnerRuntime({
        runnerId: id,
        provider: 'stub',
        route: 'local.echo',
        requestedModel: kind,
        opts,
        supportedExtraKeys: [],
        toolPolicy: {
          tools: 'not-supported',
          grounding: 'not-supported',
          webSearch: 'not-supported',
          note: 'The stub runner is deterministic local test plumbing and never invokes tools.',
        },
      })
      const started = Date.now()
      const output = await withRunnerTimeout(
        async () => {
          const lastUser = [...scenario.input.messages].reverse().find((m) => m.role === 'user')
          return kind === 'empty' ? '' : (lastUser?.content ?? '')
        },
        runtime,
        scenario.id,
        'local.echo',
      )
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
          extra: {
            runtime: buildRuntimeMetadata({
              runtime,
              temperature: opts.temperature,
              seed: opts.seed,
              reportedModel: kind,
            }),
          },
        },
      }
      if (opts.temperature !== undefined) response.meta.temperature = opts.temperature
      if (opts.seed !== undefined) response.meta.seed = opts.seed
      return response
    },
  }
}
