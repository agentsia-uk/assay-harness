import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RunRecord } from './types.js'

/**
 * Write a RunRecord to disk as JSON. Creates parent directories as needed.
 * The file format is stable: fields may be added but not renamed or typed
 * differently without a major harness version bump.
 */
export async function writeRunRecord(path: string, record: RunRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8')
}

export async function readRunRecord(path: string): Promise<RunRecord> {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as RunRecord
}

/**
 * Generate a short run id. Not cryptographic; just a collision-resistant
 * timestamp-plus-random tag used inside RunRecord.id.
 */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}`
}
