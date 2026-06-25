import { describe, expect, it } from 'vitest'

import {
  createOpenAIRunner,
  type ChatCompletionCreateParams,
  type ChatCompletionResponse,
  type OpenAIClientLike,
} from '../src/runners/openai.js'
import { PROVIDER_RUNTIME_SCHEMA_VERSION } from '../src/runners/runtime.js'
import type { Scenario } from '../src/types.js'

function makeStubClient(
  output: string,
  captured: { lastCall?: ChatCompletionCreateParams } = {},
): OpenAIClientLike {
  return {
    chat: {
      completions: {
        async create(params) {
          captured.lastCall = params
          return {
            id: 'chatcmpl-test-123',
            model: `${params.model}-2026-04-01`,
            choices: [
              { message: { content: output }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 16, total_tokens: 56 },
            system_fingerprint: 'fp_test',
          }
        },
      },
    },
  }
}

const adtechScenario: Scenario = {
  id: 'adtech-002',
  axes: ['supply-path'],
  input: {
    messages: [
      { role: 'system', content: 'You are a supply-path auditor.' },
      { role: 'user', content: 'Evaluate SSP reseller chain for path SPO-X.' },
    ],
  },
  rubric: { kind: 'programmatic', checker: 'non-empty' },
}

describe('openai runner', () => {
  it('maps scenario messages to chat.completions.create params and returns a ModelResponse', async () => {
    const captured: { lastCall?: ChatCompletionCreateParams } = {}
    const client = makeStubClient('path SPO-X cleared', captured)
    const runner = createOpenAIRunner('gpt-6', { client })

    const response = await runner.run(adtechScenario, { temperature: 0, seed: 7 })

    expect(captured.lastCall?.model).toBe('gpt-6')
    expect(captured.lastCall?.messages).toHaveLength(2)
    expect(captured.lastCall?.messages[0]).toEqual({
      role: 'system',
      content: 'You are a supply-path auditor.',
    })
    expect(captured.lastCall?.messages[1]?.role).toBe('user')
    expect(captured.lastCall?.temperature).toBe(0)
    expect(captured.lastCall?.seed).toBe(7)

    expect(response.runnerId).toBe('openai:gpt-6')
    expect(response.scenarioId).toBe('adtech-002')
    expect(response.output).toBe('path SPO-X cleared')
    expect(response.meta.provider).toBe('openai')
    expect(response.meta.model).toBe('gpt-6')
    expect(response.meta.version).toBe('gpt-6-2026-04-01')
    expect(response.meta.latencyMs).toBeGreaterThanOrEqual(0)
    expect(response.meta.temperature).toBe(0)
    expect(response.meta.seed).toBe(7)
    expect(typeof response.meta.accessedAt).toBe('string')
    expect(response.meta.extra?.finishReason).toBe('stop')
    expect(response.meta.extra?.systemFingerprint).toBe('fp_test')
    expect(response.meta.extra?.promptTokens).toBe(40)
    expect(response.meta.extra?.completionTokens).toBe(16)
    expect(response.meta.extra?.totalTokens).toBe(56)
    expect(response.meta.extra?.responseId).toBe('chatcmpl-test-123')
    const runtime = response.meta.extra?.runtime as Record<string, unknown>
    expect(runtime).toMatchObject({
      schemaVersion: PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: 'openai',
      route: 'chat.completions',
      requestedModel: 'gpt-6',
      reportedModel: 'gpt-6-2026-04-01',
      timeoutMs: null,
      timedOut: false,
    })
    expect(runtime['toolPolicy']).toMatchObject({
      tools: 'disabled',
      grounding: 'not-supported',
      webSearch: 'disabled',
    })
    expect(runtime['tokenUsage']).toMatchObject({
      promptTokens: 40,
      completionTokens: 16,
      totalTokens: 56,
    })
  })

  it('prepends runner systemPrompt when the scenario has no system message', async () => {
    const captured: { lastCall?: ChatCompletionCreateParams } = {}
    const client = makeStubClient('ok', captured)
    const runner = createOpenAIRunner('gpt-6', { client })

    const scenario: Scenario = {
      id: 'no-sys',
      axes: ['a'],
      input: { messages: [{ role: 'user', content: 'go' }] },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
    }

    await runner.run(scenario, { systemPrompt: 'You are helpful.' })
    expect(captured.lastCall?.messages[0]).toEqual({
      role: 'system',
      content: 'You are helpful.',
    })
    expect(captured.lastCall?.messages[1]).toEqual({ role: 'user', content: 'go' })
  })

  it('applies scenario-level maxTokens when present', async () => {
    const captured: { lastCall?: ChatCompletionCreateParams } = {}
    const client = makeStubClient('', captured)
    const runner = createOpenAIRunner('gpt-6-mini', { client })
    const scenario: Scenario = {
      ...adtechScenario,
      input: { ...adtechScenario.input, meta: { maxTokens: 128 } },
    }
    await runner.run(scenario)
    expect(captured.lastCall?.max_tokens).toBe(128)
  })

  it('omits max_tokens when neither scenario nor runner provides it', async () => {
    const captured: { lastCall?: ChatCompletionCreateParams } = {}
    const client = makeStubClient('', captured)
    const runner = createOpenAIRunner('gpt-6', { client })
    await runner.run(adtechScenario)
    expect(captured.lastCall?.max_tokens).toBeUndefined()
  })

  it('forwards safe extra generation options and records them in runtime metadata', async () => {
    const captured: { lastCall?: ChatCompletionCreateParams } = {}
    const client = makeStubClient('ok', captured)
    const runner = createOpenAIRunner('gpt-6', { client })

    const response = await runner.run(adtechScenario, {
      extra: { maxTokens: 64, topP: 0.8, stopSequences: ['END'] },
    })

    expect(captured.lastCall?.max_tokens).toBe(64)
    expect(captured.lastCall?.top_p).toBe(0.8)
    expect(captured.lastCall?.stop).toEqual(['END'])
    const runtime = response.meta.extra?.runtime as Record<string, unknown>
    expect(runtime['forwardedExtraKeys']).toEqual(['maxTokens', 'topP', 'stopSequences'])
    expect(runtime['options']).toMatchObject({
      maxTokens: 64,
      topP: 0.8,
      stopSequences: ['END'],
    })
  })

  it('rejects unsupported unsafe extra options before calling the provider', async () => {
    let calls = 0
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          async create() {
            calls += 1
            return makeStubClient('late').chat.completions.create({
              model: 'gpt-6',
              messages: [{ role: 'user', content: 'late' }],
            })
          },
        },
      },
    }
    const runner = createOpenAIRunner('gpt-6', { client })

    await expect(
      runner.run(adtechScenario, { extra: { tools: [] } }),
    ).rejects.toThrow(/unsupported RunnerOptions\.extra key\(s\): tools/)
    expect(calls).toBe(0)
  })

  it('enforces RunnerOptions.timeoutMs for provider calls', async () => {
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          async create(): Promise<ChatCompletionResponse> {
            return await new Promise<ChatCompletionResponse>(() => undefined)
          },
        },
      },
    }
    const runner = createOpenAIRunner('gpt-6', { client })
    await expect(runner.run(adtechScenario, { timeoutMs: 5 })).rejects.toThrow(
      /chat\.completions\.create timed out after 5ms/,
    )
  })

  it('throws a contextual error when the API call fails', async () => {
    const client: OpenAIClientLike = {
      chat: {
        completions: {
          async create() {
            throw new Error('rate_limit_exceeded')
          },
        },
      },
    }
    const runner = createOpenAIRunner('gpt-6', { client })
    await expect(runner.run(adtechScenario)).rejects.toThrow(
      /openai:gpt-6.*adtech-002.*rate_limit_exceeded/,
    )
  })

  it('requires OPENAI_API_KEY when no client is injected', async () => {
    const originalKey = process.env['OPENAI_API_KEY']
    delete process.env['OPENAI_API_KEY']
    try {
      const runner = createOpenAIRunner('gpt-6')
      await expect(runner.run(adtechScenario)).rejects.toThrow(/OPENAI_API_KEY/)
    } finally {
      if (originalKey !== undefined) process.env['OPENAI_API_KEY'] = originalKey
    }
  })
})
