import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * OpenAI Chat Completions runner.
 *
 * Status: stub. Full implementation ships with Assay-Adtech v1.
 *
 * Expected shape when implemented:
 *   - Resolve model id from the runner id suffix (e.g. "openai:gpt-6").
 *   - Map scenario.input.messages into Chat Completions messages.
 *   - Call the API with pinned model, temperature, seed (where supported).
 *   - Return ModelResponse with accessedAt, latencyMs, temperature, seed.
 *   - Respect Sharing and Publication Policy: disclose model + date per run.
 */
export function createOpenAIRunner(model: string): Runner {
  const id = `openai:${model}`
  return {
    id,
    provider: 'openai',
    model,
    async run(_scenario: Scenario, _opts: RunnerOptions = {}): Promise<ModelResponse> {
      throw new Error(
        `[${id}] openai runner not yet implemented. Ships with Assay-Adtech v1. ` +
          `Track at https://github.com/agentsia-uk/assay-harness/issues`,
      )
    },
  }
}
