import type { Runner, ModelResponse, Scenario, RunnerOptions } from '../types.js'

/**
 * Local vLLM server runner. Targets an OpenAI-compatible endpoint served by
 * vLLM (https://vllm.ai) on the user's own hardware.
 *
 * Status: stub. Full implementation ships with Assay-Adtech v1.
 *
 * Expected shape when implemented:
 *   - Read vLLM endpoint URL from env (VLLM_BASE_URL) or constructor arg.
 *   - Call the OpenAI-compatible /v1/chat/completions route.
 *   - Return ModelResponse with accessedAt, latencyMs, and the served model
 *     id from the response.
 */
export function createVllmRunner(model: string, baseUrl?: string): Runner {
  const id = `vllm:${model}`
  return {
    id,
    provider: 'vllm',
    model,
    async run(_scenario: Scenario, _opts: RunnerOptions = {}): Promise<ModelResponse> {
      const resolved = baseUrl ?? process.env.VLLM_BASE_URL ?? 'http://localhost:8000'
      throw new Error(
        `[${id}] vllm runner not yet implemented (target ${resolved}). ` +
          `Ships with Assay-Adtech v1.`,
      )
    },
  }
}
