import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  buildProofBundleManifest,
  formatProofBundleManifest,
  validateProofBundleManifest,
} from '../src/proof.js'
import { computeScenarioSetHash } from '../src/serialiser.js'
import type { Dataset, ModelAggregate, RunRecord } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

function scenario(id: string, outcomeType: string) {
  return {
    id,
    axes: ['quality'],
    input: { messages: [{ role: 'user' as const, content: `classify ${id}` }] },
    rubric: { kind: 'programmatic' as const, checker: 'non-empty' },
    meta: { source: 'synthetic', outcomeType },
  }
}

function dataset(): Dataset {
  return {
    name: 'proof-fixture',
    version: '1.0.0',
    scenarios: [
      scenario('proof-001', 'tp'),
      scenario('proof-002', 'tn'),
      scenario('proof-003', 'fp-guard'),
      scenario('proof-004', 'fn-guard'),
    ],
  }
}

function aggregate(): ModelAggregate {
  return {
    runnerId: 'stub:echo',
    axes: {
      quality: {
        mean: 0.75,
        variance: 0.0625,
        n: 4,
        confidenceInterval: {
          method: 'bootstrap',
          lower: 0.5,
          upper: 1,
          confidenceLevel: 0.95,
          iterations: 1000,
          seed: 7,
          n: 4,
        },
      },
    },
    composite: 0.75,
    weights: { quality: 1 },
    statisticalClaims: {
      method: 'bootstrap',
      confidenceLevel: 0.95,
      iterations: 1000,
      seed: 7,
      sampleUnit: 'score',
    },
  }
}

function runRecord(ds: Dataset, commandLine?: string): RunRecord {
  return {
    id: 'proof-run-001',
    dataset: { name: ds.name, version: ds.version },
    scenarioSetHash: computeScenarioSetHash(ds),
    runners: ['stub:echo'],
    createdAt: '2026-06-24T12:00:00.000Z',
    responses: ds.scenarios.map((s, index) => ({
      runnerId: 'stub:echo',
      scenarioId: s.id,
      output: index === 0 ? 'ok' : 'also ok',
      meta: {
        provider: 'stub',
        model: 'echo',
        version: '1',
        accessedAt: `2026-06-24T12:00:0${index}.000Z`,
        temperature: 0,
        seed: 11,
        latencyMs: index + 1,
      },
    })),
    scores: ds.scenarios.map((s, index) => ({
      runnerId: 'stub:echo',
      scenarioId: s.id,
      axis: 'quality',
      value: index === 0 ? 0 : 1,
    })),
    aggregates: [aggregate()],
    meta: {
      harnessVersion: '0.4.0',
      ...(commandLine ? { commandLine } : {}),
    },
  }
}

function releaseContract(scenarioSetHash: string, status: 'allowed' | 'blocked' = 'blocked') {
  return {
    schemaVersion: 'modelsmith.assay-release-contract.v2',
    benchmark: 'assay-adtech',
    corpusVersion: '1.0.0',
    rubricVersion: '1.0.0',
    generatedAt: '2026-06-24T12:00:00.000Z',
    scenarioSetHash,
    scenarioSetHashMetadata: {
      scenarioSetHash,
      shortHash: scenarioSetHash.slice(0, 12),
      scenarioCount: 4,
      heldOutOnly: true,
    },
    publicBundleHash: '0'.repeat(64),
    provenance: {
      manifestVersion: '1.0.0',
      selectionRuleHash: '1'.repeat(64),
      publicPrivateSplit: {
        public: 4,
        private: 0,
        privatePct: 0,
      },
    },
    rubric: {
      version: '1.0.0',
      harnessDependencyIds: ['mechanism-scorer-v1'],
    },
    scenarioCounts: {
      totalInManifest: 4,
      publicExported: 4,
      privateExcluded: 0,
    },
    harnessDependencyIds: ['mechanism-scorer-v1'],
    claimGate: status === 'blocked'
      ? {
          status,
          leaderboardClaimsAllowed: false,
          blocker: 'frontier rerun pending',
          gatedDomains: ['leaderboard'],
        }
      : {
          status,
          leaderboardClaimsAllowed: true,
          gatedDomains: [],
        },
    scenarios: [
      {
        id: 'proof-001',
        category: 'fixture',
        description: 'public scenario summary',
        testObjective: 'public objective',
        passCriteria: 'PRIVATE ANSWER KEY SHOULD NOT BE IN PROOF',
        failCriteria: 'PRIVATE FAILURE KEY SHOULD NOT BE IN PROOF',
      },
    ],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

describe('proof bundle manifest', () => {
  it('builds deterministic canonical output for the same inputs', () => {
    const ds = dataset()
    const record = runRecord(ds, 'assay run --dataset examples --runner stub:echo')
    const contract = releaseContract(record.scenarioSetHash!)

    const first = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
    const second = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })

    expect(formatProofBundleManifest(first)).toBe(formatProofBundleManifest(second))
    expect(first.reproducibilitySelfTest.status).toBe('passed')
    expect(first.proofIndex.map((entry) => entry.id)).toEqual([
      'run-record',
      'release-contract',
      'runner-metadata',
      'public-results',
    ])
  })

  it('redacts command lines and excludes private scenario criteria', () => {
    const ds = dataset()
    const record = runRecord(
      ds,
      'assay run --api-key sk-secret123 --token "Bearer abc123" --dataset private.json',
    )
    const contract = releaseContract(record.scenarioSetHash!)
    const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
    const serialized = formatProofBundleManifest(manifest)

    expect(manifest.run.redactedCommandLine).toContain('--api-key [REDACTED]')
    expect(manifest.run.redactedCommandLine).toContain('--token [REDACTED]')
    expect(serialized).not.toContain('sk-secret123')
    expect(serialized).not.toContain('Bearer abc123')
    expect(serialized).not.toContain('PRIVATE ANSWER KEY')
    expect(serialized).not.toContain('PRIVATE FAILURE KEY')
  })

  it('validates checksums and catches tampered inputs', () => {
    const ds = dataset()
    const record = runRecord(ds)
    const contract = releaseContract(record.scenarioSetHash!)
    const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })

    expect(validateProofBundleManifest(manifest, { runRecord: record, releaseContract: contract, dataset: ds })).toEqual({
      valid: true,
      errors: [],
    })

    const tampered: RunRecord = {
      ...record,
      meta: { ...record.meta, harnessVersion: 'tampered' },
    }
    const result = validateProofBundleManifest(manifest, {
      runRecord: tampered,
      releaseContract: contract,
      dataset: ds,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('runRecord checksum')
  })

  it('preserves blocked claim status without failing the proof self-test', () => {
    const ds = dataset()
    const record = runRecord(ds)
    const manifest = buildProofBundleManifest({
      runRecord: record,
      releaseContract: releaseContract(record.scenarioSetHash!, 'blocked'),
      dataset: ds,
    })

    expect(manifest.claimGate).toMatchObject({
      status: 'blocked',
      leaderboardClaimsAllowed: false,
      blocker: 'frontier rerun pending',
    })
    expect(manifest.reproducibilitySelfTest.status).toBe('passed')
  })

  it('builds a proof manifest through the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = runRecord(ds, 'assay run --secret supersecret')
      const contract = releaseContract(record.scenarioSetHash!)
      const runPath = join(dir, 'run.json')
      const contractPath = join(dir, 'contract.json')
      const outPath = join(dir, 'proof.json')
      await writeJson(runPath, record)
      await writeJson(contractPath, contract)

      const { stdout } = await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        CLI,
        'proof',
        'build',
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--out',
        outPath,
      ], { cwd: ROOT })

      expect(stdout).toContain(`wrote ${outPath}`)
      const manifest = JSON.parse(await readFile(outPath, 'utf8')) as {
        schemaVersion: string
        run: { redactedCommandLine: string }
      }
      expect(manifest.schemaVersion).toBe('assay.proof-bundle.v1')
      expect(manifest.run.redactedCommandLine).toContain('--secret [REDACTED]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
