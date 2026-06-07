import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../src/retry.js'

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on a transient 503 error and succeeds', async () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 })
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok')
    const result = await withRetry(fn, { baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('exhausts all attempts and rethrows', async () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 })
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).rejects.toThrow('Rate limited')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on a non-transient error', async () => {
    const err = new Error('Bad request')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('Bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('respects a custom isRetryable predicate', async () => {
    const err = new Error('custom error')
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('done')
    const result = await withRetry(fn, { baseDelayMs: 0, isRetryable: () => true })
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
