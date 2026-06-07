import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { withJudgeCache } from '../src/judge-cache.js'
import type { LLMJudgeExecutor, LLMJudgeResult, ModelResponse, Scenario, LLMJudgeRubric } from '../src/types.js'

function makeRequest() {
  const response: ModelResponse = {
    runnerId: 'stub:echo',
    scenarioId: 'test-1',
    output: 'hello world',
    meta: { provider: 'stub', model: 'echo', accessedAt: new Date().toISOString(), latencyMs: 0 },
  }
  const rubric: LLMJudgeRubric = {
    kind: 'llm-judge',
    judge: 'test-judge:v1',
    prompt: 'Rate this: {response}',
    calibration: { setId: 'x', minimumAgreement: 0.7, observedAgreement: 0.9, promptHash: 'abc' },
  }
  const scenario = {
    id: 'test-1',
    axes: ['quality'],
    input: { messages: [{ role: 'user' as const, content: 'hi' }] },
    rubric,
  } as Scenario
  return { response, scenario, rubric, renderedPrompt: 'Rate this: hello world' }
}

describe('withJudgeCache', () => {
  let tmpDir: string

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    tmpDir = mkdtempSync(`${tmpdir()}/judge-cache-test-`)
  })

  afterEach(async () => {
    const { rmSync } = await import('node:fs')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls the underlying executor on a cache miss', async () => {
    const inner: LLMJudgeExecutor = vi.fn(async () => ({ value: 0.9, rationale: 'good' }))
    const cached = withJudgeCache(inner, { dir: tmpDir })
    const result = await cached(makeRequest())
    expect(inner).toHaveBeenCalledOnce()
    expect(result).toEqual({ value: 0.9, rationale: 'good' })
  })

  it('returns cached result without calling the executor again', async () => {
    const inner: LLMJudgeExecutor = vi.fn(async () => ({ value: 0.75 }))
    const cached = withJudgeCache(inner, { dir: tmpDir })
    const req = makeRequest()
    await cached(req)
    const second = await cached(req)
    expect(inner).toHaveBeenCalledOnce()
    expect(second).toMatchObject({ value: 0.75 })
  })

  it('ignores stale cache entries and re-calls the executor', async () => {
    const inner: LLMJudgeExecutor = vi.fn(async () => ({ value: 0.5 }))
    const cached = withJudgeCache(inner, { dir: tmpDir, ttlMs: 0 })
    const req = makeRequest()
    await cached(req)
    await cached(req)
    expect(inner).toHaveBeenCalledTimes(2)
  })

  it('produces different cache keys for different judge models', async () => {
    const calls: string[] = []
    const inner: LLMJudgeExecutor = vi.fn((req) => {
      calls.push(req.rubric.judge)
      return { value: 1.0 }
    })
    const cached = withJudgeCache(inner, { dir: tmpDir })
    const req1 = makeRequest()
    const req2 = makeRequest()
    req2.rubric = { ...req2.rubric, judge: 'other-judge:v2' }
    await cached(req1)
    await cached(req2)
    expect(inner).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['test-judge:v1', 'other-judge:v2'])
  })
})
