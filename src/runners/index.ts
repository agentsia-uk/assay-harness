import type { Runner } from '../types.js'
import { createStubRunner } from './stub.js'
import { createAnthropicRunner } from './anthropic.js'
import { createOpenAIRunner } from './openai.js'
import { createGoogleRunner } from './google.js'
import { createHuggingFaceRunner } from './huggingface.js'
import { createVllmRunner } from './vllm.js'

/**
 * Resolve a runner from a colon-separated id.
 *
 * Supported forms:
 *   stub:echo
 *   stub:empty
 *   anthropic:<model-id>
 *   openai:<model-id>
 *   google:<model-id>
 *   hf:<org>/<repo>         e.g. hf:Qwen/Qwen3-4B-Instruct-2507
 *   vllm:<model-id>         reads VLLM_BASE_URL from env by default
 */
export function resolveRunner(id: string): Runner {
  const [provider, ...rest] = id.split(':')
  const suffix = rest.join(':')
  if (!provider || !suffix) {
    throw new Error(`resolveRunner: expected provider:model, got "${id}"`)
  }

  switch (provider) {
    case 'stub':
      if (suffix !== 'echo' && suffix !== 'empty') {
        throw new Error(`resolveRunner: stub runner kind must be 'echo' or 'empty', got "${suffix}"`)
      }
      return createStubRunner(suffix)
    case 'anthropic':
      return createAnthropicRunner(suffix)
    case 'openai':
      return createOpenAIRunner(suffix)
    case 'google':
      return createGoogleRunner(suffix)
    case 'hf':
      return createHuggingFaceRunner(suffix)
    case 'vllm':
      return createVllmRunner(suffix)
    default:
      throw new Error(
        `resolveRunner: unknown provider "${provider}". ` +
          `Known: stub, anthropic, openai, google, hf, vllm.`,
      )
  }
}

export {
  createStubRunner,
  createAnthropicRunner,
  createOpenAIRunner,
  createGoogleRunner,
  createHuggingFaceRunner,
  createVllmRunner,
}
