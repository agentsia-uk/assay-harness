import { describe, expect, it } from 'vitest'

import {
  createGoogleRunner,
  type GenerateContentParams,
  type GoogleClientLike,
} from '../src/runners/google.js'
import type { Scenario } from '../src/types.js'

function makeStubClient(
  output: string,
  captured: { lastCall?: GenerateContentParams } = {},
): GoogleClientLike {
  return {
    models: {
      async generateContent(params) {
        captured.lastCall = params
        return {
          modelVersion: `${params.model}-2026-04-01`,
          candidates: [
            {
              content: { parts: [{ text: output }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 42,
            candidatesTokenCount: 24,
            totalTokenCount: 66,
          },
        }
      },
    },
  }
}

const adtechScenario: Scenario = {
  id: 'adtech-003',
  axes: ['brand-safety'],
  input: {
    messages: [
      { role: 'system', content: 'You are a brand-safety reviewer.' },
      { role: 'user', content: 'Rate the IAB category of "mfa-site-001".' },
    ],
  },
  rubric: { kind: 'programmatic', checker: 'non-empty' },
}

describe('google runner', () => {
  it('maps scenario messages to generateContent params and returns a ModelResponse', async () => {
    const captured: { lastCall?: GenerateContentParams } = {}
    const client = makeStubClient('category IAB7-44', captured)
    const runner = createGoogleRunner('gemini-3-pro', { client })

    const response = await runner.run(adtechScenario, { temperature: 0.2, seed: 11 })

    expect(captured.lastCall?.model).toBe('gemini-3-pro')
    expect(captured.lastCall?.contents).toEqual([
      { role: 'user', parts: [{ text: 'Rate the IAB category of "mfa-site-001".' }] },
    ])
    expect(captured.lastCall?.config?.systemInstruction).toBe('You are a brand-safety reviewer.')
    expect(captured.lastCall?.config?.temperature).toBe(0.2)
    // Seed is intentionally not forwarded to the Gemini API.
    expect((captured.lastCall?.config as Record<string, unknown> | undefined)?.['seed']).toBeUndefined()

    expect(response.runnerId).toBe('google:gemini-3-pro')
    expect(response.scenarioId).toBe('adtech-003')
    expect(response.output).toBe('category IAB7-44')
    expect(response.meta.provider).toBe('google')
    expect(response.meta.model).toBe('gemini-3-pro')
    expect(response.meta.version).toBe('gemini-3-pro-2026-04-01')
    expect(response.meta.latencyMs).toBeGreaterThanOrEqual(0)
    expect(response.meta.temperature).toBe(0.2)
    expect(response.meta.seed).toBe(11)
    expect(typeof response.meta.accessedAt).toBe('string')
    expect(response.meta.extra?.finishReason).toBe('STOP')
    expect(response.meta.extra?.promptTokens).toBe(42)
    expect(response.meta.extra?.candidatesTokens).toBe(24)
    expect(response.meta.extra?.totalTokens).toBe(66)
  })

  it('joins multiple system messages into systemInstruction', async () => {
    const captured: { lastCall?: GenerateContentParams } = {}
    const client = makeStubClient('ok', captured)
    const runner = createGoogleRunner('gemini-3-flash', { client })

    const scenario: Scenario = {
      id: 'multi-sys',
      axes: ['a'],
      input: {
        messages: [
          { role: 'system', content: 'First system.' },
          { role: 'system', content: 'Second system.' },
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'acknowledged' },
          { role: 'user', content: 'continue' },
        ],
      },
      rubric: { kind: 'programmatic', checker: 'non-empty' },
    }

    await runner.run(scenario)
    expect(captured.lastCall?.config?.systemInstruction).toBe('First system.\n\nSecond system.')
    // assistant-role messages get mapped to Gemini's 'model' role.
    expect(captured.lastCall?.contents).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ text: 'acknowledged' }] },
      { role: 'user', parts: [{ text: 'continue' }] },
    ])
  })

  it('applies scenario-level maxTokens as maxOutputTokens', async () => {
    const captured: { lastCall?: GenerateContentParams } = {}
    const client = makeStubClient('', captured)
    const runner = createGoogleRunner('gemini-3-pro', { client })
    const scenario: Scenario = {
      ...adtechScenario,
      input: { ...adtechScenario.input, meta: { maxTokens: 96 } },
    }
    await runner.run(scenario)
    expect(captured.lastCall?.config?.maxOutputTokens).toBe(96)
  })

  it('omits maxOutputTokens when neither scenario nor runner provides it', async () => {
    const captured: { lastCall?: GenerateContentParams } = {}
    const client = makeStubClient('', captured)
    const runner = createGoogleRunner('gemini-3-pro', { client })
    await runner.run(adtechScenario)
    expect(captured.lastCall?.config?.maxOutputTokens).toBeUndefined()
  })

  it('throws a contextual error when the API call fails', async () => {
    const client: GoogleClientLike = {
      models: {
        async generateContent() {
          throw new Error('quota_exceeded')
        },
      },
    }
    const runner = createGoogleRunner('gemini-3-pro', { client })
    await expect(runner.run(adtechScenario)).rejects.toThrow(
      /google:gemini-3-pro.*adtech-003.*quota_exceeded/,
    )
  })

  it('requires GOOGLE_API_KEY when no client is injected', async () => {
    const originalKey = process.env['GOOGLE_API_KEY']
    delete process.env['GOOGLE_API_KEY']
    try {
      const runner = createGoogleRunner('gemini-3-pro')
      await expect(runner.run(adtechScenario)).rejects.toThrow(/GOOGLE_API_KEY/)
    } finally {
      if (originalKey !== undefined) process.env['GOOGLE_API_KEY'] = originalKey
    }
  })
})
