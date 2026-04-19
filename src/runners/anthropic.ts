import type Anthropic from '@anthropic-ai/sdk'

import type { Message, ModelResponse, Runner, RunnerOptions, Scenario } from '../types.js'

/**
 * Minimal Anthropic client contract the runner depends on. Kept narrow so
 * unit tests can inject a stub without pulling the full SDK surface.
 */
export interface AnthropicClientLike {
  messages: {
    create(params: MessagesCreateParams): Promise<MessagesCreateResponse>
  }
}

export interface MessagesCreateParams {
  model: string
  max_tokens: number
  temperature?: number
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export interface MessagesCreateResponse {
  model: string
  content: Array<{ type: string; text?: string }>
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface AnthropicRunnerOptions {
  /**
   * Inject a client for tests. If omitted, a real @anthropic-ai/sdk client is
   * constructed lazily on first run. Requires ANTHROPIC_API_KEY in env.
   */
  client?: AnthropicClientLike
  /**
   * Override max_tokens. Default 4096. Anthropic requires this field.
   */
  defaultMaxTokens?: number
}

const DEFAULT_MAX_TOKENS = 4096

/**
 * Anthropic Messages API runner.
 *
 * Reads ANTHROPIC_API_KEY from env, unless an explicit client is provided
 * via AnthropicRunnerOptions (for tests). The model id is taken verbatim as
 * the suffix of the runner id, e.g. 'anthropic:claude-opus-4-7' resolves to
 * the API model 'claude-opus-4-7'.
 *
 * Per the Anthropic Commercial Terms, benchmark publication is permitted
 * with disclosure of model version and access date per run. Those fields
 * are serialised into ModelResponse.meta.
 */
export function createAnthropicRunner(
  model: string,
  opts: AnthropicRunnerOptions = {},
): Runner {
  const id = `anthropic:${model}`
  let cached: AnthropicClientLike | null = opts.client ?? null

  async function getClient(): Promise<AnthropicClientLike> {
    if (cached) return cached
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (init?: { apiKey?: string }) => Anthropic
    }
    const apiKey = process.env['ANTHROPIC_API_KEY']
    if (!apiKey) {
      throw new Error(
        `[${id}] ANTHROPIC_API_KEY is not set. ` +
          `Set it in the environment or pass a client via createAnthropicRunner's opts.`,
      )
    }
    cached = new mod.default({ apiKey }) as unknown as AnthropicClientLike
    return cached
  }

  return {
    id,
    provider: 'anthropic',
    model,
    async run(scenario: Scenario, runOpts: RunnerOptions = {}): Promise<ModelResponse> {
      const client = await getClient()
      const { system, messages } = splitMessages(scenario.input.messages, runOpts.systemPrompt)
      const maxTokens = readMaxTokens(scenario, opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)
      const started = Date.now()

      const params: MessagesCreateParams = {
        model,
        max_tokens: maxTokens,
        messages,
      }
      if (system) params.system = system
      if (runOpts.temperature !== undefined) params.temperature = runOpts.temperature

      let apiResponse: MessagesCreateResponse
      try {
        apiResponse = await client.messages.create(params)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(
          `[${id}] messages.create failed for scenario "${scenario.id}": ${message}`,
        )
      }

      const latencyMs = Date.now() - started
      const output = extractText(apiResponse)

      const response: ModelResponse = {
        runnerId: id,
        scenarioId: scenario.id,
        output,
        meta: {
          provider: 'anthropic',
          model,
          version: apiResponse.model,
          accessedAt: new Date().toISOString(),
          latencyMs,
          extra: {
            maxTokens,
            stopReason: apiResponse.stop_reason ?? null,
            inputTokens: apiResponse.usage?.input_tokens,
            outputTokens: apiResponse.usage?.output_tokens,
          },
        },
      }
      if (runOpts.temperature !== undefined) response.meta.temperature = runOpts.temperature
      if (runOpts.seed !== undefined) response.meta.seed = runOpts.seed

      return response
    },
  }
}

/**
 * Anthropic separates the system prompt from the messages array. Collapse
 * any system-role messages in scenario.input.messages into a single system
 * string, falling back to opts.systemPrompt if no system-role messages are
 * present.
 */
function splitMessages(
  input: Message[],
  fallbackSystem?: string,
): { system?: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const systems: string[] = []
  const remaining: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of input) {
    if (m.role === 'system') {
      systems.push(m.content)
    } else {
      remaining.push({ role: m.role, content: m.content })
    }
  }
  if (remaining.length === 0) {
    throw new Error('anthropic: scenario must include at least one user or assistant message')
  }
  const system = systems.length > 0 ? systems.join('\n\n') : fallbackSystem
  const result: { system?: string; messages: { role: 'user' | 'assistant'; content: string }[] } =
    { messages: remaining }
  if (system) result.system = system
  return result
}

function readMaxTokens(scenario: Scenario, fallback: number): number {
  const fromScenario = scenario.input.meta?.['maxTokens']
  if (typeof fromScenario === 'number' && Number.isFinite(fromScenario) && fromScenario > 0) {
    return Math.floor(fromScenario)
  }
  return fallback
}

function extractText(response: MessagesCreateResponse): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n')
    .trim()
}
