import { describe, expect, it } from 'vitest'

import { createAnthropicRunner, type AnthropicClientLike, type MessagesCreateParams } from '../src/runners/anthropic.js'
import type { Scenario } from '../src/types.js'

function makeStubClient(
  output: string,
  captured: { lastCall?: MessagesCreateParams } = {},
): AnthropicClientLike {
  return {
    messages: {
      async create(params) {
        captured.lastCall = params
        return {
          model: `${params.model}-20260101`,
          content: [{ type: 'text', text: output }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 8 },
        }
      },
    },
  }
}

const exactMatchScenario: Scenario = {
  id: 'adtech-001',
  axes: ['bid-shading'],
  input: {
    messages: [
      { role: 'system', content: 'You are an RTB trading assistant.' },
      { role: 'user', content: 'Given CPM 0.85, expected win 0.6, recommend a bid shade factor.' },
    ],
  },
  rubric: { kind: 'programmatic', checker: 'non-empty' },
}

describe('anthropic runner', () => {
  it('maps scenario messages to messages.create params and returns a ModelResponse', async () => {
    const captured: { lastCall?: MessagesCreateParams } = {}
    const client = makeStubClient('shade factor 0.7', captured)
    const runner = createAnthropicRunner('claude-opus-4-7', { client })

    const response = await runner.run(exactMatchScenario, { temperature: 0 })

    expect(captured.lastCall).toBeDefined()
    expect(captured.lastCall?.model).toBe('claude-opus-4-7')
    expect(captured.lastCall?.system).toBe('You are an RTB trading assistant.')
    expect(captured.lastCall?.messages).toEqual([
      { role: 'user', content: expect.stringContaining('CPM') },
    ])
    expect(captured.lastCall?.temperature).toBe(0)
    expect(captured.lastCall?.max_tokens).toBeGreaterThan(0)

    expect(response.runnerId).toBe('anthropic:claude-opus-4-7')
    expect(response.scenarioId).toBe('adtech-001')
    expect(response.output).toBe('shade factor 0.7')
    expect(response.meta.provider).toBe('anthropic')
    expect(response.meta.model).toBe('claude-opus-4-7')
    expect(response.meta.version).toBe('claude-opus-4-7-20260101')
    expect(response.meta.latencyMs).toBeGreaterThanOrEqual(0)
    expect(response.meta.temperature).toBe(0)
    expect(typeof response.meta.accessedAt).toBe('string')
    expect(response.meta.extra?.stopReason).toBe('end_turn')
    expect(response.meta.extra?.inputTokens).toBe(12)
    expect(response.meta.extra?.outputTokens).toBe(8)
  })

  it('joins multiple system messages with a blank line', async () => {
    const captured: { lastCall?: MessagesCreateParams } = {}
    const client = makeStubClient('', captured)
    const runner = createAnthropicRunner('claude-sonnet-4-6', { client })

    const scenario: Scenario = {
      id: 's',
      axes: ['a'],
      input: {
        messages: [
          { role: 'system', content: 'First system.' },
          { role: 'system', content: 'Second system.' },
          { role: 'user', content: 'go' },
        ],
      },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
    }

    await runner.run(scenario)
    expect(captured.lastCall?.system).toBe('First system.\n\nSecond system.')
  })

  it('applies scenario-level maxTokens when present', async () => {
    const captured: { lastCall?: MessagesCreateParams } = {}
    const client = makeStubClient('', captured)
    const runner = createAnthropicRunner('claude-haiku-4-5', { client })

    const scenario: Scenario = {
      ...exactMatchScenario,
      input: {
        ...exactMatchScenario.input,
        meta: { maxTokens: 256 },
      },
    }

    await runner.run(scenario)
    expect(captured.lastCall?.max_tokens).toBe(256)
  })

  it('throws a contextual error when the API call fails', async () => {
    const client: AnthropicClientLike = {
      messages: {
        async create() {
          throw new Error('rate_limit_exceeded')
        },
      },
    }
    const runner = createAnthropicRunner('claude-opus-4-7', { client })
    await expect(runner.run(exactMatchScenario)).rejects.toThrow(
      /anthropic:claude-opus-4-7.*adtech-001.*rate_limit_exceeded/,
    )
  })

  it('requires ANTHROPIC_API_KEY when no client is injected', async () => {
    const originalKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      const runner = createAnthropicRunner('claude-opus-4-7')
      await expect(runner.run(exactMatchScenario)).rejects.toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (originalKey !== undefined) process.env['ANTHROPIC_API_KEY'] = originalKey
    }
  })
})
