import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * Google Gemini API runner.
 *
 * Status: stub. Full implementation ships with Assay-Adtech v1.
 *
 * Expected shape when implemented:
 *   - Resolve model id from the runner id suffix (e.g. "google:gemini-3-pro").
 *   - Map scenario.input.messages into Gemini's contents schema.
 *   - Call generateContent with pinned model, temperature.
 *   - Do NOT enable Search grounding: the Gemini API Additional Terms prohibit
 *     analysing Grounded Results, which would be implicated by evaluation use.
 *   - Return ModelResponse with accessedAt, latencyMs, provider meta.
 */
export function createGoogleRunner(model: string): Runner {
  const id = `google:${model}`
  return {
    id,
    provider: 'google',
    model,
    async run(_scenario: Scenario, _opts: RunnerOptions = {}): Promise<ModelResponse> {
      throw new Error(
        `[${id}] google runner not yet implemented. Ships with Assay-Adtech v1. ` +
          `Track at https://github.com/agentsia-uk/assay-harness/issues`,
      )
    },
  }
}
