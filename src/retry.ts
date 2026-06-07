export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  isRetryable?: (err: unknown) => boolean
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504])

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(msg)) return true
    const statusMatch = /status[:\s]+(\d{3})/i.exec(msg) ?? /(\d{3})\s+error/i.exec(msg)
    if (statusMatch) {
      const code = Number(statusMatch[1])
      if (TRANSIENT_STATUS_CODES.has(code)) return true
    }
  }
  if (typeof err === 'object' && err !== null) {
    const maybeStatus = (err as Record<string, unknown>)['status']
    if (typeof maybeStatus === 'number' && TRANSIENT_STATUS_CODES.has(maybeStatus)) return true
  }
  return false
}

function jitteredDelay(attempt: number, baseDelayMs: number): number {
  const exp = Math.pow(2, attempt) * baseDelayMs
  return exp + Math.random() * exp * 0.2
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const isRetryable = opts.isRetryable ?? isTransientError

  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt + 1 >= maxAttempts || !isRetryable(err)) throw err
      await new Promise((res) => setTimeout(res, jitteredDelay(attempt, baseDelayMs)))
    }
  }
  throw lastErr
}
