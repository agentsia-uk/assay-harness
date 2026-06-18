import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Dataset, RunRecord, Scenario } from './types.js'
import { assertValidRunRecord } from './validate.js'

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
  const parsed: unknown = JSON.parse(raw)
  assertValidRunRecord(parsed)
  return parsed
}

/**
 * Stable serialisation of a single scenario's runner-visible identity: the
 * prompt messages, the axes it contributes to, and the rubric. Deliberately
 * excludes free-form `meta` (notes, source labels) so cosmetic metadata edits
 * do not move the corpus hash, mirroring Modelsmith's scenario-set-hash intent.
 */
function scenarioHashContribution(scenario: Scenario): unknown {
  return {
    id: scenario.id,
    axes: [...scenario.axes].sort(),
    input: scenario.input,
    rubric: scenario.rubric,
  }
}

/**
 * Compute a deterministic content hash over a dataset's scenario set. The hash
 * is stable across hosts (no timestamps, paths, or run-specific data) and is
 * order-independent: the same scenarios always produce the same hash, whatever
 * order the loader returned them in.
 *
 * This is the harness-side corpus identity. It binds a RunRecord to a UNIQUE
 * scenario set so a score cannot be silently attributed to a different corpus
 * carrying the same dataset version tag.
 */
export function computeScenarioSetHash(dataset: Dataset): string {
  const members = dataset.scenarios
    .map(scenarioHashContribution)
    .sort((a, b) =>
      ((a as { id: string }).id).localeCompare((b as { id: string }).id),
    )
  const canonical = JSON.stringify({
    name: dataset.name,
    version: dataset.version,
    scenarios: members,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
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
