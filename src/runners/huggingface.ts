import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * Hugging Face Inference endpoint runner.
 *
 * Status: stub. Full implementation ships with Assay-Adtech v1.
 *
 * Expected shape when implemented:
 *   - Resolve the HF repo id from the runner id suffix, e.g.
 *     "hf:Qwen/Qwen3-4B-Instruct-2507".
 *   - Call the HF Inference API (dedicated endpoint or Inference API).
 *   - Map messages into the model's chat template when available.
 *   - Return ModelResponse with accessedAt, latencyMs, provider meta.
 */
export function createHuggingFaceRunner(repoId: string): Runner {
  const id = `hf:${repoId}`
  return {
    id,
    provider: 'huggingface',
    model: repoId,
    async run(_scenario: Scenario, _opts: RunnerOptions = {}): Promise<ModelResponse> {
      throw new Error(
        `[${id}] huggingface runner not yet implemented. Ships with Assay-Adtech v1. ` +
          `Track at https://github.com/agentsia-uk/assay-harness/issues`,
      )
    },
  }
}
