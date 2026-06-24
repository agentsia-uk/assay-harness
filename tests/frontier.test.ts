import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  readFrontierContractMetadata,
  verifyFrontierQuorum,
  type FrontierProofMetadata,
} from '../src/index.js'

import contractAllowed from './fixtures/frontier-proof/contract-allowed.json'
import contractBlocked from './fixtures/frontier-proof/contract-blocked.json'
import proofMissingCells from './fixtures/frontier-proof/proof-missing-cells.json'
import proofPass from './fixtures/frontier-proof/proof-pass.json'
import proofStale from './fixtures/frontier-proof/proof-stale.json'
import proofWrongHash from './fixtures/frontier-proof/proof-wrong-hash.json'

const execFileAsync = promisify(execFile)
const ROOT = resolve(__dirname, '..')
const CLI = resolve(ROOT, 'src', 'cli.ts')
const FIXTURES = resolve(ROOT, 'tests', 'fixtures', 'frontier-proof')
const PROVIDERS = ['claude', 'gpt', 'gemini']

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

function fixturePath(name: string): string {
  return resolve(FIXTURES, name)
}

function codes(result: ReturnType<typeof verifyFrontierQuorum>): string[] {
  return result.errors.map((error) => error.code)
}

describe('frontier quorum verifier', () => {
  it('passes when public proof metadata satisfies the configured quorum', () => {
    const result = verifyFrontierQuorum(proofPass, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(true)
    expect(result.matchedProviders).toEqual(PROVIDERS)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('fails closed and reports missing provider cells clearly', () => {
    const result = verifyFrontierQuorum(proofMissingCells, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(false)
    expect(result.missingProviders).toEqual(['gpt', 'gemini'])
    expect(codes(result)).toContain('missing-provider-cell')
    expect(codes(result)).toContain('quorum-not-met')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'missing provider cell for "gpt"',
    )
  })

  it('fails closed on a wrong top-level proof hash', () => {
    const result = verifyFrontierQuorum(proofWrongHash, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('wrong-hash')
    expect(result.errors.map((error) => error.message).join('\n')).toContain('wrong hash')
  })

  it('fails closed when the release claim gate is blocked', () => {
    const result = verifyFrontierQuorum(proofPass, {
      ...readFrontierContractMetadata(contractBlocked),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('blocked-claim-gate')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'frontier cells have not been rerun',
    )
  })

  it('fails closed when proof metadata tries to lower the governed quorum', () => {
    const loweredQuorum: FrontierProofMetadata = {
      ...(proofPass as FrontierProofMetadata),
      quorum: {
        ...(proofPass as FrontierProofMetadata).quorum,
        required: 1,
      },
    }

    const result = verifyFrontierQuorum(loweredQuorum, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('invalid-quorum-config')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'below governed minimum 2',
    )
  })

  it('fails closed when max proof age is enforced without generatedAt evidence', () => {
    const proofWithoutGeneratedAt = { ...(proofPass as FrontierProofMetadata) }
    delete proofWithoutGeneratedAt.generatedAt

    const result = verifyFrontierQuorum(proofWithoutGeneratedAt, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
      maxProofAgeDays: 7,
      now: '2026-06-24T00:00:00.000Z',
    })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('invalid-proof-metadata')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'generatedAt is required',
    )
  })

  it('rejects release contracts with missing or malformed claim gates', () => {
    expect(() =>
      readFrontierContractMetadata({
        ...(contractAllowed as Record<string, unknown>),
        claimGate: { status: 'maybe' },
      }),
    ).toThrow(/invalid claimGate/)

    const contractWithoutClaimGate = { ...(contractAllowed as Record<string, unknown>) }
    delete contractWithoutClaimGate['claimGate']
    expect(() => readFrontierContractMetadata(contractWithoutClaimGate)).toThrow(
      /requires claimGate/,
    )
  })

  it('fails closed on stale proof metadata', () => {
    const result = verifyFrontierQuorum(proofStale, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('stale-proof')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'proof expired at 2000-01-01T00:00:00.000Z',
    )
  })

  it('reports stale provider cells without blocking when quorum is still met', () => {
    const proofWithOneStaleProvider: FrontierProofMetadata = {
      ...(proofPass as FrontierProofMetadata),
      providerCells: (proofPass as FrontierProofMetadata).providerCells.map((cell) =>
        cell.provider === 'gemini'
          ? {
              ...cell,
              scenarioSetHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            }
          : cell,
      ),
    }

    const result = verifyFrontierQuorum(proofWithOneStaleProvider, {
      ...readFrontierContractMetadata(contractAllowed),
      providers: PROVIDERS,
    })

    expect(result.ok).toBe(true)
    expect(result.matchedProviders).toEqual(['claude', 'gpt'])
    expect(result.staleProviders).toEqual(['gemini'])
    expect(result.warnings.map((warning) => warning.code)).toContain('stale-provider-cell')
  })

  it('fails closed on unsupported hash schema versions', () => {
    const unsupportedProof = {
      ...(proofPass as FrontierProofMetadata),
      hashSchemaVersion: 'v99',
      providerCells: (proofPass as FrontierProofMetadata).providerCells.map((cell) => ({
        ...cell,
        hashSchemaVersion: 'v99',
      })),
    }

    const result = verifyFrontierQuorum(unsupportedProof, { providers: PROVIDERS })

    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('unsupported-hash-schema-version')
    expect(result.errors.map((error) => error.message).join('\n')).toContain(
      'supported hash schema versions: v1, v2',
    )
  })
})

describe('assay frontier verify', () => {
  it('verifies a passing proof through the CLI', async () => {
    const { stdout, stderr, code } = await runCli([
      'frontier',
      'verify',
      fixturePath('proof-pass.json'),
      '--contract',
      fixturePath('contract-allowed.json'),
      '--provider',
      'claude,gpt,gemini',
    ])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('frontier quorum verified')
    expect(stdout).toContain('3/2 provider cell(s) match')
  })

  it('returns a non-zero exit and clear stderr for blocked claim gates', async () => {
    const { stdout, stderr, code } = await runCli([
      'frontier',
      'verify',
      fixturePath('proof-pass.json'),
      '--contract',
      fixturePath('contract-blocked.json'),
      '--provider',
      'claude,gpt,gemini',
    ])

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('blocked claim gate')
  })
})
