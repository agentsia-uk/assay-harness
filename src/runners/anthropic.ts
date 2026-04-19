import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * Anthropic Messages API runner.
 *
 * Status: stub. Full implementation ships with Assay-Adtech v1.
 *
 * Expected shape when implemented:
 *   - Resolve model id from the runner id suffix (e.g. "anthropic:claude-opus-4-7").
 *   - Map scenario.input.messages into the Anthropic Messages schema.
 *   - Call the Messages API with pinned model version, temperature, and max tokens.
 *   - Return ModelResponse with accessedAt, latencyMs, and provider meta.
 *   - Respect API Terms of Service: disclose model + date in meta; do not
 *     use outputs for competing-model training.
 */
export function createAnthropicRunner(model: string): Runner {
  const id = `anthropic:${model}`
  return {
    id,
    provider: 'anthropic',
    model,
    async run(_scenario: Scenario, _opts: RunnerOptions = {}): Promise<ModelResponse> {
      throw new Error(
        `[${id}] anthropic runner not yet implemented. Ships with Assay-Adtech v1. ` +
          `Track at https://github.com/agnt-os/assay-harness/issues`,
      )
    },
  }
}
