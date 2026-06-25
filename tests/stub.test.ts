import { describe, expect, it } from 'vitest'

import { PROVIDER_RUNTIME_SCHEMA_VERSION } from '../src/runners/runtime.js'
import { createStubRunner } from '../src/runners/stub.js'
import type { Scenario } from '../src/types.js'

const scenario: Scenario = {
  id: 'stub-runtime',
  axes: ['smoke'],
  input: {
    messages: [
      { role: 'system', content: 'Echo user content.' },
      { role: 'user', content: 'hello' },
    ],
  },
  rubric: { kind: 'programmatic', checker: 'non-empty' },
}

describe('stub runner runtime metadata', () => {
  it('returns the common provider runtime metadata block', async () => {
    const runner = createStubRunner('echo')

    const response = await runner.run(scenario, { temperature: 0, seed: 3 })

    expect(response.output).toBe('hello')
    const runtime = response.meta.extra?.runtime as Record<string, unknown>
    expect(runtime).toMatchObject({
      schemaVersion: PROVIDER_RUNTIME_SCHEMA_VERSION,
      provider: 'stub',
      route: 'local.echo',
      requestedModel: 'echo',
      reportedModel: 'echo',
      timeoutMs: null,
      timedOut: false,
    })
    expect(runtime['options']).toMatchObject({ temperature: 0, seed: 3 })
    expect(runtime['toolPolicy']).toMatchObject({
      tools: 'not-supported',
      grounding: 'not-supported',
      webSearch: 'not-supported',
    })
  })

  it('rejects extra provider options because the stub has no provider surface', async () => {
    const runner = createStubRunner('echo')

    await expect(
      runner.run(scenario, { extra: { maxTokens: 10 } }),
    ).rejects.toThrow(/Supported keys: none/)
  })
})
