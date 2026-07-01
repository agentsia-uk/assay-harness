import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { aggregate as aggregateScores } from '../src/aggregator.js'
import {
  buildProofBundleManifest,
  formatProofBundleManifest,
  validateProofBundleManifest,
} from '../src/proof.js'
import { score } from '../src/rubric.js'
import { computeScenarioSetHash } from '../src/serialiser.js'
import type { ClaimCard, Dataset, EnvironmentRunMetadata, ModelAggregate, RunRecord, Score } from '../src/types.js'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')

async function runCli(args: string[]): Promise<{ stdout: string, stderr: string, code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT },
    )
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string, stderr?: string, code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

function scenario(id: string, outcomeType: string) {
  return {
    id,
    axes: ['quality'],
    input: { messages: [{ role: 'user' as const, content: `classify ${id}` }] },
    rubric: { kind: 'programmatic' as const, checker: 'keyword', params: { expected: ['ok'] } },
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

function replayRunRecord(ds: Dataset): RunRecord {
  const responses = ds.scenarios.map((s, index) => ({
    runnerId: 'stub:echo',
    scenarioId: s.id,
    output: 'ok',
    meta: {
      provider: 'stub',
      model: 'echo',
      version: '1',
      accessedAt: `2026-06-24T12:00:0${index}.000Z`,
      temperature: 0,
      seed: 11,
      latencyMs: index + 1,
    },
  }))
  const scores = responses.flatMap((response) => score(response, ds.scenarios.find((s) => s.id === response.scenarioId)!) as Score[])
  const aggregates = aggregateScores(scores, {
    confidence: {
      method: 'bootstrap',
      iterations: 1000,
      confidenceLevel: 0.95,
      seed: 7,
    },
    responses,
    sliceMetadataByScenario: Object.fromEntries(ds.scenarios.map((s) => [s.id, {}])),
  })
  return {
    id: 'proof-replay-run-001',
    dataset: { name: ds.name, version: ds.version },
    scenarioSetHash: computeScenarioSetHash(ds),
    scenarioSetHashSchemaVersion: 'v1',
    runners: ['stub:echo'],
    createdAt: '2026-06-24T12:00:00.000Z',
    responses,
    scores,
    aggregates,
    meta: {
      harnessVersion: '0.4.0',
      commandLine: 'assay run --dataset fixtures --runner stub:echo --ci-seed 7',
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

function claimCard(record: RunRecord, overrides: Partial<ClaimCard> = {}): ClaimCard {
  return {
    schemaVersion: 'assay.claim-card.v1',
    dataset: record.dataset,
    scenarioSetHash: record.scenarioSetHash!,
    hashSchemaVersion: record.scenarioSetHashSchemaVersion ?? 'v1',
    status: 'allowed',
    leaderboardClaimsAllowed: true,
    generatedAt: '2026-06-24T12:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function traceBundle(record: RunRecord): EnvironmentRunMetadata {
  return {
    schemaVersion: 'assay.environment-run-metadata.v1',
    results: [
      {
        schemaVersion: 'assay.environment-trace.v1',
        scenarioId: record.responses[0]!.scenarioId,
        runnerId: record.runners[0]!,
        environmentId: 'proof-fixture-env',
        steps: [],
        finalState: { ok: true },
        validators: [{ id: 'complete', passed: true, value: 1 }],
        redaction: { applied: false, redactedPaths: [] },
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

  it('rejects proof manifests whose claim gate diverges from the release contract', () => {
    const ds = dataset()
    const record = runRecord(ds)
    const contract = releaseContract(record.scenarioSetHash!, 'blocked')
    const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
    const forged = {
      ...manifest,
      claimGate: {
        status: 'allowed' as const,
        leaderboardClaimsAllowed: true,
        gatedDomains: [],
      },
    }

    const result = validateProofBundleManifest(forged, {
      runRecord: record,
      releaseContract: contract,
      dataset: ds,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('claimGate does not match')
  })

  it('fails the proof self-test when claim-allowed material contains analysis-only scores', () => {
    const ds = dataset()
    const record = runRecord(ds)
    record.scores[0]!.claimStatus = 'analysis-only'
    const manifest = buildProofBundleManifest({
      runRecord: record,
      releaseContract: releaseContract(record.scenarioSetHash!, 'allowed'),
      dataset: ds,
    })

    expect(manifest.claimGate.leaderboardClaimsAllowed).toBe(true)
    expect(manifest.reproducibilitySelfTest.status).toBe('failed')
    expect(
      manifest.reproducibilitySelfTest.checks.map((check) => check.detail).join('\n'),
    ).toContain('analysis-only')
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
  }, 120_000)

  it('verifies a proof manifest through the CLI and emits machine-readable JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = replayRunRecord(ds)
      const contract = releaseContract(record.scenarioSetHash!, 'allowed')
      const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
      const proofPath = join(dir, 'proof.json')
      const runPath = join(dir, 'run.json')
      const contractPath = join(dir, 'contract.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(proofPath, manifest)
      await writeJson(runPath, record)
      await writeJson(contractPath, contract)
      await writeJson(datasetPath, ds)

      const { stdout, stderr, code } = await runCli([
        'proof',
        'verify',
        proofPath,
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
        '--json',
      ])

      expect(code).toBe(0)
      expect(stderr).toBe('')
      const result = JSON.parse(stdout) as { valid: boolean, errors: string[], checks: Array<{ name: string, status: string }> }
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.checks.map((check) => check.name)).toContain('proof-manifest')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('returns clear human failure reasons for checksum mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = replayRunRecord(ds)
      const contract = releaseContract(record.scenarioSetHash!, 'allowed')
      const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
      const tamperedRecord = {
        ...record,
        meta: { ...record.meta, harnessVersion: 'tampered' },
      }
      const proofPath = join(dir, 'proof.json')
      const runPath = join(dir, 'run.json')
      const contractPath = join(dir, 'contract.json')
      const datasetPath = join(dir, 'dataset.json')
      await writeJson(proofPath, manifest)
      await writeJson(runPath, tamperedRecord)
      await writeJson(contractPath, contract)
      await writeJson(datasetPath, ds)

      const { stdout, stderr, code } = await runCli([
        'proof',
        'verify',
        proofPath,
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
      ])

      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('Proof verification failed')
      expect(stderr).toContain('runRecord checksum')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('fails closed on wrong proof hash schema and missing trace inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = replayRunRecord(ds)
      const contract = releaseContract(record.scenarioSetHash!, 'allowed')
      const traces = traceBundle(record)
      const manifest = buildProofBundleManifest({
        runRecord: record,
        releaseContract: contract,
        dataset: ds,
        traceBundle: traces,
      })
      expect(manifest.reproducibilitySelfTest.status).toBe('passed')
      expect(validateProofBundleManifest(manifest, {
        runRecord: record,
        releaseContract: contract,
        dataset: ds,
        traceBundle: traces,
      })).toEqual({ valid: true, errors: [] })
      const wrongHashManifest = {
        ...manifest,
        hashSchema: {
          ...manifest.hashSchema,
          canonicalization: 'wrong-json-canonical-v9',
        },
      }
      const proofPath = join(dir, 'proof.json')
      const wrongHashPath = join(dir, 'proof-wrong-hash-schema.json')
      const runPath = join(dir, 'run.json')
      const contractPath = join(dir, 'contract.json')
      const datasetPath = join(dir, 'dataset.json')
      const tracePath = join(dir, 'traces.json')
      await writeJson(proofPath, manifest)
      await writeJson(wrongHashPath, wrongHashManifest)
      await writeJson(runPath, record)
      await writeJson(contractPath, contract)
      await writeJson(datasetPath, ds)
      await writeJson(tracePath, traces)

      const wrongHash = await runCli([
        'proof',
        'verify',
        wrongHashPath,
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
        '--trace-bundle',
        tracePath,
        '--json',
      ])
      expect(wrongHash.code).toBe(1)
      expect(JSON.parse(wrongHash.stdout).errors.join('\n')).toContain('hashSchema.canonicalization')

      const missingTrace = await runCli([
        'proof',
        'verify',
        proofPath,
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
      ])
      expect(missingTrace.code).toBe(1)
      expect(missingTrace.stderr).toContain('traceBundle input is required')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('uses the shared claim-card eligibility gate for leaderboard proof verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = replayRunRecord(ds)
      const contract = releaseContract(record.scenarioSetHash!, 'allowed')
      const proofPath = join(dir, 'proof.json')
      const runPath = join(dir, 'run.json')
      const datasetPath = join(dir, 'dataset.json')
      const contractPath = join(dir, 'contract.json')
      const staleClaimPath = join(dir, 'stale-claim.json')
      const blockedClaimPath = join(dir, 'blocked-claim.json')
      const malformedClaimPath = join(dir, 'malformed-claim.json')
      const analysisRunPath = join(dir, 'analysis-run.json')
      const analysisProofPath = join(dir, 'analysis-proof.json')
      const allowedClaimPath = join(dir, 'allowed-claim.json')
      const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
      const analysisRecord: RunRecord = {
        ...record,
        scores: record.scores.map((item, index) =>
          index === 0 ? { ...item, claimStatus: 'analysis-only' as const } : item,
        ),
      }
      const analysisManifest = buildProofBundleManifest({
        runRecord: analysisRecord,
        releaseContract: contract,
        dataset: ds,
      })
      await writeJson(proofPath, manifest)
      await writeJson(runPath, record)
      await writeJson(datasetPath, ds)
      await writeJson(contractPath, contract)
      await writeJson(staleClaimPath, claimCard(record, { expiresAt: '2000-01-01T00:00:00.000Z' }))
      await writeJson(blockedClaimPath, claimCard(record, {
        status: 'blocked',
        leaderboardClaimsAllowed: false,
        blocker: 'frontier proof expired',
      }))
      await writeJson(malformedClaimPath, { schemaVersion: 'assay.claim-card.v1' })
      await writeJson(allowedClaimPath, claimCard(record))
      await writeJson(analysisRunPath, analysisRecord)
      await writeJson(analysisProofPath, analysisManifest)

      const baseArgs = [
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
        '--leaderboard-eligible',
      ]
      const stale = await runCli(['proof', 'verify', proofPath, '--run', runPath, ...baseArgs, '--claim-card', staleClaimPath])
      expect(stale.code).toBe(1)
      expect(stale.stderr).toContain('ClaimCard has expired')

      const blocked = await runCli(['proof', 'verify', proofPath, '--run', runPath, ...baseArgs, '--claim-card', blockedClaimPath])
      expect(blocked.code).toBe(1)
      expect(blocked.stderr).toContain('ClaimCard blocks leaderboard claims')

      const malformed = await runCli(['proof', 'verify', proofPath, '--run', runPath, ...baseArgs, '--claim-card', malformedClaimPath])
      expect(malformed.code).toBe(1)
      expect(malformed.stderr).toContain('ClaimCard.dataset must be an object')

      const analysisOnly = await runCli([
        'proof',
        'verify',
        analysisProofPath,
        '--run',
        analysisRunPath,
        ...baseArgs,
        '--claim-card',
        allowedClaimPath,
      ])
      expect(analysisOnly.code).toBe(1)
      expect(analysisOnly.stderr).toContain('analysis-only')

      const allowed = await runCli(['proof', 'verify', proofPath, '--run', runPath, ...baseArgs, '--claim-card', allowedClaimPath])
      expect(allowed.code).toBe(0)
      expect(allowed.stdout).toContain('Proof verification passed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('replays pinned outputs and fails when regenerated aggregates diverge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assay-proof-'))
    try {
      const ds = dataset()
      const record = replayRunRecord(ds)
      const contract = releaseContract(record.scenarioSetHash!, 'allowed')
      const manifest = buildProofBundleManifest({ runRecord: record, releaseContract: contract, dataset: ds })
      const tamperedRecord: RunRecord = {
        ...record,
        aggregates: record.aggregates.map((item) => ({ ...item, composite: 0.25 })),
      }
      const tamperedManifest = buildProofBundleManifest({
        runRecord: tamperedRecord,
        releaseContract: contract,
        dataset: ds,
      })
      const runPath = join(dir, 'run.json')
      const proofPath = join(dir, 'proof.json')
      const contractPath = join(dir, 'contract.json')
      const datasetPath = join(dir, 'dataset.json')
      const tamperedRunPath = join(dir, 'run-tampered.json')
      const tamperedProofPath = join(dir, 'proof-tampered.json')
      await writeJson(runPath, record)
      await writeJson(proofPath, manifest)
      await writeJson(contractPath, contract)
      await writeJson(datasetPath, ds)
      await writeJson(tamperedRunPath, tamperedRecord)
      await writeJson(tamperedProofPath, tamperedManifest)

      const passed = await runCli([
        'proof',
        'replay',
        '--run',
        runPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
        '--proof',
        proofPath,
        '--json',
      ])
      expect(passed.code).toBe(0)
      expect(JSON.parse(passed.stdout)).toMatchObject({ valid: true, replayed: true })

      const failed = await runCli([
        'proof',
        'replay',
        '--run',
        tamperedRunPath,
        '--contract',
        contractPath,
        '--dataset',
        datasetPath,
        '--proof',
        tamperedProofPath,
      ])
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('aggregate replay mismatch')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
