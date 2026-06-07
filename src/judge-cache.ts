import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMJudgeExecutor, LLMJudgeResult } from './types.js'

const DEFAULT_CACHE_DIR = '.cache/judge'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export interface JudgeCacheOptions {
  dir?: string
  ttlMs?: number
}

function cacheKey(judge: string, rubricContent: string, text: string): string {
  return createHash('sha256')
    .update(judge)
    .update('\x00')
    .update(rubricContent)
    .update('\x00')
    .update(text)
    .digest('hex')
}

interface CacheEntry {
  result: LLMJudgeResult
  savedAt: number
}

export function withJudgeCache(
  executor: LLMJudgeExecutor,
  opts: JudgeCacheOptions = {},
): LLMJudgeExecutor {
  const dir = opts.dir ?? DEFAULT_CACHE_DIR
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS

  return async (request) => {
    const { rubric, response } = request
    const key = cacheKey(rubric.judge, rubric.prompt, response.output)
    const file = join(dir, `${key}.json`)

    try {
      const raw = await readFile(file, 'utf8')
      const entry = JSON.parse(raw) as CacheEntry
      if (Date.now() - entry.savedAt < ttlMs) {
        return entry.result
      }
    } catch {
      // cache miss or parse error — proceed to call the judge
    }

    const result = await executor(request)

    try {
      await mkdir(dir, { recursive: true })
      const entry: CacheEntry = { result, savedAt: Date.now() }
      await writeFile(file, JSON.stringify(entry, null, 2), 'utf8')
    } catch {
      // non-fatal — a failed write just means no cache for this entry
    }

    return result
  }
}
