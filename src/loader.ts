import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'

import type { Dataset, Scenario } from './types.js'
import {
  isMultiTurnScenario,
  MultiTurnError,
  validateMultiTurnScenario,
} from './runners/multi-turn.js'
import {
  EnvironmentError,
  isEnvironmentScenario,
  validateEnvironmentScenario,
} from './environment.js'

/**
 * Load a dataset from a directory of JSON scenario files or a single JSON
 * bundle file.
 *
 * Directory layout:
 *   examples/scenarios/
 *     dataset.json          # optional; contains name, version, description
 *     scenarios/
 *       001-hello.json
 *       002-world.json
 *
 * Bundle layout:
 *   examples/scenarios.json
 *     { name, version, scenarios: [...] }
 */
export async function loadDataset(source: string): Promise<Dataset> {
  const abs = resolve(source)
  const stats = await stat(abs)

  if (stats.isDirectory()) {
    return loadDatasetFromDirectory(abs)
  }
  if (stats.isFile()) {
    const raw = await readFile(abs, 'utf8')
    return parseBundle(raw, basename(abs))
  }
  throw new Error(`loader: source is neither a file nor a directory: ${abs}`)
}

async function loadDatasetFromDirectory(dir: string): Promise<Dataset> {
  const entries = await readdir(dir)
  const manifestPath = entries.find((e) => e === 'dataset.json')

  let name = basename(dir)
  let version = '0.0.0'
  let description: string | undefined

  if (manifestPath) {
    const raw = await readFile(join(dir, manifestPath), 'utf8')
    const manifest = JSON.parse(raw) as Partial<Dataset>
    if (manifest.name) name = manifest.name
    if (manifest.version) version = manifest.version
    if (manifest.description) description = manifest.description
  }

  const scenarioDir = entries.includes('scenarios') ? join(dir, 'scenarios') : dir
  const files = (await readdir(scenarioDir)).filter(
    (f) => f.endsWith('.json') && f !== 'dataset.json',
  )

  const scenarios: Scenario[] = []
  for (const f of files) {
    const raw = await readFile(join(scenarioDir, f), 'utf8')
    const parsed = JSON.parse(raw) as Scenario
    validateScenarioItem(parsed, f)
    scenarios.push(parsed)
  }

  scenarios.sort((a, b) => a.id.localeCompare(b.id))

  const dataset: Dataset = { name, version, scenarios }
  if (description) dataset.description = description
  return dataset
}

function parseBundle(raw: string, hint: string): Dataset {
  const parsed = JSON.parse(raw) as Partial<Dataset>
  if (!parsed.name) throw new Error(`loader: bundle missing 'name' field (${hint})`)
  if (!parsed.version) throw new Error(`loader: bundle missing 'version' field (${hint})`)
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error(`loader: bundle 'scenarios' must be an array (${hint})`)
  }
  parsed.scenarios.forEach((s, i) => validateScenarioItem(s, `${hint}#${i}`))
  return parsed as Dataset
}

function validateScenarioItem(value: unknown, hint: string): void {
  if (looksLikeEnvironmentScenario(value)) {
    try {
      validateEnvironmentScenario(value, `loader: environment scenario (${hint})`)
    } catch (error) {
      if (error instanceof EnvironmentError) {
        throw new Error(error.message)
      }
      throw error
    }
    return
  }

  if (looksLikePublicMultiTurn(value)) {
    try {
      validateMultiTurnScenario(value, {
        requirePublicMarker: true,
        rejectUnknownKeys: true,
        hint: `loader: multi-turn scenario (${hint})`,
      })
    } catch (error) {
      if (error instanceof MultiTurnError) {
        throw new Error(error.message)
      }
      throw error
    }
    return
  }

  validateScenario(value as Scenario, hint)
}

function validateScenario(s: Scenario, hint: string): void {
  if (!s.id) throw new Error(`loader: scenario missing 'id' (${hint})`)
  if (!Array.isArray(s.axes) || s.axes.length === 0) {
    throw new Error(`loader: scenario '${s.id}' must declare at least one axis (${hint})`)
  }
  if (s.meta?.['multiTurn'] === true) {
    throw new Error(
      `loader: scenario '${s.id}' uses legacy meta.multiTurn without the public ` +
        `multi-turn shape (${hint}). Use top-level multiTurn: true with userTurns ` +
        `and persistenceCriteria so the CLI can run the persistence grader.`,
    )
  }
  if (!s.input?.messages || s.input.messages.length === 0) {
    throw new Error(`loader: scenario '${s.id}' missing input.messages (${hint})`)
  }
  if (!s.rubric) throw new Error(`loader: scenario '${s.id}' missing rubric (${hint})`)
}

function looksLikePublicMultiTurn(value: unknown): boolean {
  if (isMultiTurnScenario(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return v['conversationHistory'] !== undefined || v['multiTurn'] !== undefined
}

function looksLikeEnvironmentScenario(value: unknown): boolean {
  if (isEnvironmentScenario(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return v['environment'] !== undefined
}
