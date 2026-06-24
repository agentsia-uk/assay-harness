import { FRONTIER_QUORUM_REQUIRED } from './mechanism.js'

export const FRONTIER_PROOF_SCHEMA_VERSION = 'assay.frontier-proof.v1'
export const DEFAULT_FRONTIER_HASH_SCHEMA_VERSION = 'v1'
export const SUPPORTED_FRONTIER_HASH_SCHEMA_VERSIONS = ['v1', 'v2'] as const

export type FrontierIssueCode =
  | 'invalid-proof-metadata'
  | 'unsupported-proof-schema-version'
  | 'unsupported-hash-schema-version'
  | 'wrong-hash'
  | 'missing-claim-gate'
  | 'blocked-claim-gate'
  | 'stale-proof'
  | 'invalid-quorum-config'
  | 'missing-provider-cell'
  | 'stale-provider-cell'
  | 'provider-cell-unverified'
  | 'quorum-not-met'

export interface FrontierHashIdentity {
  hashSchemaVersion: string
  scenarioSetHash: string
}

export interface FrontierClaimGate {
  status: 'allowed' | 'blocked'
  leaderboardClaimsAllowed?: boolean
  blocker?: string
  gatedDomains?: string[]
}

export interface FrontierProviderProofCell extends FrontierHashIdentity {
  provider: string
  model?: string
  status: 'verified' | 'failed' | 'blocked' | 'stale'
  generatedAt?: string
  expiresAt?: string
  proofUrl?: string
}

export interface FrontierProofMetadata extends FrontierHashIdentity {
  schemaVersion?: typeof FRONTIER_PROOF_SCHEMA_VERSION
  benchmark?: string
  generatedAt?: string
  expiresAt?: string
  claimGate?: FrontierClaimGate
  quorum?: {
    required?: number
    providers?: string[]
  }
  providerCells: FrontierProviderProofCell[]
}

export interface FrontierContractMetadata extends FrontierHashIdentity {
  claimGate?: FrontierClaimGate
}

export interface FrontierVerificationIssue {
  code: FrontierIssueCode
  message: string
  provider?: string
  expected?: FrontierHashIdentity
  actual?: FrontierHashIdentity
}

export interface FrontierQuorumOptions {
  /** Scenario-set hash expected by the release contract or caller. */
  scenarioSetHash?: string
  /** Hash algorithm/schema version expected by the release contract or caller. */
  hashSchemaVersion?: string
  /** Provider ids that form the configured quorum set. */
  providers?: string[]
  /** Number of configured providers required to verify the current hash. */
  requiredCount?: number
  /**
   * Claim gate from the release contract. When present, it overrides the proof
   * metadata gate so a stale proof cannot self-authorise a blocked contract.
   */
  claimGate?: FrontierClaimGate
  /** Hash schema versions accepted by this harness build. Defaults to v1 + v2. */
  supportedHashSchemaVersions?: readonly string[]
  /** Test hook for expiry checks. */
  now?: Date | string
  /** Optional freshness policy layered on top of proof/cell expiresAt fields. */
  maxProofAgeDays?: number
}

export interface FrontierQuorumResult {
  ok: boolean
  expected: FrontierHashIdentity
  requiredCount: number
  configuredProviders: string[]
  matchedProviders: string[]
  missingProviders: string[]
  staleProviders: string[]
  errors: FrontierVerificationIssue[]
  warnings: FrontierVerificationIssue[]
}

export class FrontierVerificationError extends Error {
  readonly result: FrontierQuorumResult

  constructor(result: FrontierQuorumResult) {
    super(formatFrontierVerificationResult(result))
    this.name = 'FrontierVerificationError'
    this.result = result
  }
}

/**
 * Verify public frontier proof metadata against an expected corpus identity.
 * This function is intentionally metadata-only: it never imports runners,
 * writes baseline rows, or calls frontier model APIs.
 */
export function verifyFrontierQuorum(
  proofInput: unknown,
  options: FrontierQuorumOptions = {},
): FrontierQuorumResult {
  const errors: FrontierVerificationIssue[] = []
  const warnings: FrontierVerificationIssue[] = []
  const providerFindings: FrontierVerificationIssue[] = []
  const supportedHashSchemaVersions =
    options.supportedHashSchemaVersions ?? SUPPORTED_FRONTIER_HASH_SCHEMA_VERSIONS
  const now = normaliseNow(options.now)

  const proofObj = asRecord(proofInput)
  if (!proofObj) {
    errors.push(issue('invalid-proof-metadata', 'frontier proof metadata must be a JSON object'))
    return emptyResult(errors, warnings)
  }

  const proofSchemaVersion = optionalString(proofObj, 'schemaVersion')
  if (
    proofSchemaVersion !== undefined &&
    proofSchemaVersion !== FRONTIER_PROOF_SCHEMA_VERSION
  ) {
    errors.push(
      issue(
        'unsupported-proof-schema-version',
        `unsupported frontier proof schemaVersion "${proofSchemaVersion}"; ` +
          `supported schemaVersion is "${FRONTIER_PROOF_SCHEMA_VERSION}"`,
      ),
    )
  }

  const proofHashSchemaVersion = requiredString(
    proofObj,
    'hashSchemaVersion',
    'frontierProof.hashSchemaVersion',
    errors,
  )
  const proofScenarioSetHash = requiredString(
    proofObj,
    'scenarioSetHash',
    'frontierProof.scenarioSetHash',
    errors,
  )

  const expected: FrontierHashIdentity = {
    hashSchemaVersion: options.hashSchemaVersion ?? proofHashSchemaVersion ?? '',
    scenarioSetHash: options.scenarioSetHash ?? proofScenarioSetHash ?? '',
  }

  if (expected.hashSchemaVersion) {
    assertSupportedHashSchemaVersion(
      expected.hashSchemaVersion,
      supportedHashSchemaVersions,
      'expected hashSchemaVersion',
      errors,
    )
  }
  if (proofHashSchemaVersion) {
    assertSupportedHashSchemaVersion(
      proofHashSchemaVersion,
      supportedHashSchemaVersions,
      'proof hashSchemaVersion',
      errors,
    )
  }
  if (
    proofHashSchemaVersion &&
    proofScenarioSetHash &&
    (proofHashSchemaVersion !== expected.hashSchemaVersion ||
      proofScenarioSetHash !== expected.scenarioSetHash)
  ) {
    errors.push(
      issue(
        'wrong-hash',
        `wrong hash: proof is keyed to (${proofHashSchemaVersion}, ${shortHash(proofScenarioSetHash)}) ` +
          `but expected (${expected.hashSchemaVersion}, ${shortHash(expected.scenarioSetHash)})`,
        { expected, actual: { hashSchemaVersion: proofHashSchemaVersion, scenarioSetHash: proofScenarioSetHash } },
      ),
    )
  }

  const proofExpiry = optionalString(proofObj, 'expiresAt')
  if (proofExpiry) {
    pushExpiryIssue(proofExpiry, now, 'proof', errors)
  }
  const proofGeneratedAt = optionalString(proofObj, 'generatedAt')
  if (options.maxProofAgeDays !== undefined) {
    if (proofGeneratedAt) {
      pushMaxAgeIssue(proofGeneratedAt, options.maxProofAgeDays, now, errors)
    } else {
      errors.push(
        issue(
          'invalid-proof-metadata',
          'frontierProof.generatedAt is required when maxProofAgeDays is enforced',
        ),
      )
    }
  }

  const proofClaimGate = parseClaimGate(proofObj['claimGate'], 'frontierProof.claimGate', errors)
  const claimGate = options.claimGate ?? proofClaimGate
  if (!claimGate) {
    errors.push(
      issue(
        'missing-claim-gate',
        'missing claim gate: frontier verification requires an allowed release contract or proof claimGate',
      ),
    )
  } else if (claimGate.status !== 'allowed' || claimGate.leaderboardClaimsAllowed === false) {
    errors.push(
      issue(
        'blocked-claim-gate',
        `blocked claim gate: status=${claimGate.status}, ` +
          `leaderboardClaimsAllowed=${claimGate.leaderboardClaimsAllowed ?? 'unspecified'}` +
          (claimGate.blocker ? `; blocker=${claimGate.blocker}` : ''),
      ),
    )
  }

  const providerCells = parseProviderCells(proofObj['providerCells'], errors)
  const proofQuorum = parseProofQuorum(proofObj['quorum'], errors)
  const configuredProviders = uniqueNonEmptyStrings(
    options.providers ?? proofQuorum.providers ?? providerCells.map((cell) => cell.provider),
  )
  const requiredCount = options.requiredCount ?? proofQuorum.required ?? FRONTIER_QUORUM_REQUIRED

  if (configuredProviders.length === 0) {
    errors.push(
      issue(
        'invalid-quorum-config',
        'frontier quorum requires at least one configured provider',
      ),
    )
  }
  if (!Number.isInteger(requiredCount) || requiredCount < 1) {
    errors.push(
      issue(
        'invalid-quorum-config',
        `frontier quorum requiredCount must be a positive integer; got ${JSON.stringify(requiredCount)}`,
      ),
    )
  } else if (requiredCount < FRONTIER_QUORUM_REQUIRED) {
    errors.push(
      issue(
        'invalid-quorum-config',
        `frontier quorum requiredCount ${requiredCount} is below governed minimum ${FRONTIER_QUORUM_REQUIRED}`,
      ),
    )
  } else if (configuredProviders.length > 0 && requiredCount > configuredProviders.length) {
    errors.push(
      issue(
        'invalid-quorum-config',
        `frontier quorum requires ${requiredCount} providers but only ` +
          `${configuredProviders.length} configured provider(s) were supplied`,
      ),
    )
  }

  const matchedProviders: string[] = []
  const missingProviders: string[] = []
  const staleProviders: string[] = []

  for (const provider of configuredProviders) {
    const cells = providerCells.filter((cell) => cell.provider === provider)
    if (cells.length === 0) {
      missingProviders.push(provider)
      providerFindings.push(
        issue('missing-provider-cell', `missing provider cell for "${provider}"`, {
          provider,
          expected,
        }),
      )
      continue
    }

    const currentCells = cells.filter(
      (cell) =>
        cell.hashSchemaVersion === expected.hashSchemaVersion &&
        cell.scenarioSetHash === expected.scenarioSetHash,
    )
    if (currentCells.length === 0) {
      staleProviders.push(provider)
      providerFindings.push(
        issue(
          'stale-provider-cell',
          `stale provider cell for "${provider}": no cell matches ` +
            `(${expected.hashSchemaVersion}, ${shortHash(expected.scenarioSetHash)})`,
          {
            provider,
            expected,
            actual: {
              hashSchemaVersion: cells[0].hashSchemaVersion,
              scenarioSetHash: cells[0].scenarioSetHash,
            },
          },
        ),
      )
      continue
    }

    const verifiedCell = currentCells.find((cell) => {
      if (cell.status !== 'verified') return false
      return !isExpired(cell.expiresAt, now)
    })
    if (verifiedCell) {
      matchedProviders.push(provider)
      continue
    }

    const staleCell = currentCells.find((cell) => cell.status === 'stale' || isExpired(cell.expiresAt, now))
    if (staleCell) {
      staleProviders.push(provider)
      providerFindings.push(
        issue(
          'stale-provider-cell',
          `stale provider cell for "${provider}": current-hash cell is stale or expired`,
          { provider, expected },
        ),
      )
    } else {
      providerFindings.push(
        issue(
          'provider-cell-unverified',
          `provider cell for "${provider}" is not verified for the current hash`,
          { provider, expected },
        ),
      )
    }
  }

  if (matchedProviders.length < requiredCount) {
    errors.push(...providerFindings)
    errors.push(
      issue(
        'quorum-not-met',
        `frontier quorum not met: ${matchedProviders.length}/${requiredCount} verified provider ` +
          `cell(s) match (${expected.hashSchemaVersion}, ${shortHash(expected.scenarioSetHash)})`,
        { expected },
      ),
    )
  } else {
    warnings.push(...providerFindings)
  }

  return {
    ok: errors.length === 0,
    expected,
    requiredCount,
    configuredProviders,
    matchedProviders,
    missingProviders,
    staleProviders,
    errors,
    warnings,
  }
}

export function assertFrontierQuorum(
  proofInput: unknown,
  options: FrontierQuorumOptions = {},
): FrontierQuorumResult {
  const result = verifyFrontierQuorum(proofInput, options)
  if (!result.ok) {
    throw new FrontierVerificationError(result)
  }
  return result
}

export function readFrontierContractMetadata(contractInput: unknown): FrontierContractMetadata {
  const contract = asRecord(contractInput)
  if (!contract) {
    throw new Error('frontier contract metadata must be a JSON object')
  }

  const scenarioSetHash = optionalString(contract, 'scenarioSetHash')
  if (!scenarioSetHash) {
    throw new Error('frontier contract metadata requires scenarioSetHash')
  }

  const metadata = asRecord(contract['scenarioSetHashMetadata'])
  const hashSchemaVersion =
    optionalString(metadata, 'hashSchemaVersion') ??
    optionalString(contract, 'hashSchemaVersion') ??
    DEFAULT_FRONTIER_HASH_SCHEMA_VERSION
  if (contract['claimGate'] === undefined) {
    throw new Error('frontier contract metadata requires claimGate')
  }
  const errors: FrontierVerificationIssue[] = []
  const claimGate = parseClaimGate(contract['claimGate'], 'contract.claimGate', errors)
  if (errors.length > 0 || !claimGate) {
    throw new Error(
      `frontier contract metadata has invalid claimGate: ` +
        errors.map((error) => error.message).join('; '),
    )
  }

  return { scenarioSetHash, hashSchemaVersion, claimGate }
}

export function formatFrontierVerificationResult(result: FrontierQuorumResult): string {
  const summary =
    `frontier quorum ${result.ok ? 'verified' : 'failed'}: ` +
    `${result.matchedProviders.length}/${result.requiredCount} provider cell(s) match ` +
    `(${result.expected.hashSchemaVersion}, ${shortHash(result.expected.scenarioSetHash)})`
  const lines = [summary]
  if (result.errors.length > 0) {
    lines.push(...result.errors.map((error) => `  - ${error.message}`))
  }
  if (result.warnings.length > 0) {
    lines.push('warnings:')
    lines.push(...result.warnings.map((warning) => `  - ${warning.message}`))
  }
  return lines.join('\n')
}

function emptyResult(
  errors: FrontierVerificationIssue[],
  warnings: FrontierVerificationIssue[],
): FrontierQuorumResult {
  return {
    ok: false,
    expected: { hashSchemaVersion: '', scenarioSetHash: '' },
    requiredCount: FRONTIER_QUORUM_REQUIRED,
    configuredProviders: [],
    matchedProviders: [],
    missingProviders: [],
    staleProviders: [],
    errors,
    warnings,
  }
}

function parseProofQuorum(
  value: unknown,
  errors: FrontierVerificationIssue[],
): { required?: number, providers?: string[] } {
  if (value === undefined) return {}
  const obj = asRecord(value)
  if (!obj) {
    errors.push(issue('invalid-proof-metadata', 'frontierProof.quorum must be a JSON object'))
    return {}
  }
  const required = optionalNumber(obj, 'required')
  const providers = optionalStringArray(obj, 'providers', 'frontierProof.quorum.providers', errors)
  return { required, providers }
}

function parseProviderCells(
  value: unknown,
  errors: FrontierVerificationIssue[],
): FrontierProviderProofCell[] {
  if (!Array.isArray(value)) {
    errors.push(issue('invalid-proof-metadata', 'frontierProof.providerCells must be an array'))
    return []
  }

  const cells: FrontierProviderProofCell[] = []
  for (const [index, rawCell] of value.entries()) {
    const path = `frontierProof.providerCells[${index}]`
    const cell = asRecord(rawCell)
    if (!cell) {
      errors.push(issue('invalid-proof-metadata', `${path} must be a JSON object`))
      continue
    }

    const provider = requiredString(cell, 'provider', `${path}.provider`, errors)
    const hashSchemaVersion = requiredString(cell, 'hashSchemaVersion', `${path}.hashSchemaVersion`, errors)
    const scenarioSetHash = requiredString(cell, 'scenarioSetHash', `${path}.scenarioSetHash`, errors)
    const status = requiredString(cell, 'status', `${path}.status`, errors)
    if (!provider || !hashSchemaVersion || !scenarioSetHash || !status) continue
    if (!['verified', 'failed', 'blocked', 'stale'].includes(status)) {
      errors.push(
        issue(
          'invalid-proof-metadata',
          `${path}.status must be one of verified, failed, blocked, stale; got ${JSON.stringify(status)}`,
        ),
      )
      continue
    }

    const parsedCell: FrontierProviderProofCell = {
      provider,
      hashSchemaVersion,
      scenarioSetHash,
      status: status as FrontierProviderProofCell['status'],
    }
    const model = optionalString(cell, 'model')
    const generatedAt = optionalString(cell, 'generatedAt')
    const expiresAt = optionalString(cell, 'expiresAt')
    const proofUrl = optionalString(cell, 'proofUrl')
    if (model !== undefined) parsedCell.model = model
    if (generatedAt !== undefined) parsedCell.generatedAt = generatedAt
    if (expiresAt !== undefined) parsedCell.expiresAt = expiresAt
    if (proofUrl !== undefined) parsedCell.proofUrl = proofUrl
    cells.push(parsedCell)
  }
  return cells
}

function parseClaimGate(
  value: unknown,
  path: string,
  errors: FrontierVerificationIssue[],
): FrontierClaimGate | undefined {
  if (value === undefined) return undefined
  const obj = asRecord(value)
  if (!obj) {
    errors.push(issue('invalid-proof-metadata', `${path} must be a JSON object`))
    return undefined
  }
  const status = requiredString(obj, 'status', `${path}.status`, errors)
  if (!status) return undefined
  if (status !== 'allowed' && status !== 'blocked') {
    errors.push(
      issue(
        'invalid-proof-metadata',
        `${path}.status must be "allowed" or "blocked"; got ${JSON.stringify(status)}`,
      ),
    )
    return undefined
  }
  const gate: FrontierClaimGate = { status }
  const leaderboardClaimsAllowed = optionalBoolean(obj, 'leaderboardClaimsAllowed')
  const blocker = optionalString(obj, 'blocker')
  const gatedDomains = optionalStringArray(obj, 'gatedDomains', `${path}.gatedDomains`, errors)
  if (leaderboardClaimsAllowed !== undefined) gate.leaderboardClaimsAllowed = leaderboardClaimsAllowed
  if (blocker !== undefined) gate.blocker = blocker
  if (gatedDomains !== undefined) gate.gatedDomains = gatedDomains
  return gate
}

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: FrontierVerificationIssue[],
): string | undefined {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(issue('invalid-proof-metadata', `${path} must be a non-empty string`))
    return undefined
  }
  return value
}

function optionalString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' ? value : undefined
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key]
  return typeof value === 'boolean' ? value : undefined
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: FrontierVerificationIssue[],
): string[] | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    errors.push(issue('invalid-proof-metadata', `${path} must be an array of strings`))
    return undefined
  }
  return value
}

function assertSupportedHashSchemaVersion(
  version: string,
  supported: readonly string[],
  label: string,
  errors: FrontierVerificationIssue[],
): void {
  if (!supported.includes(version)) {
    errors.push(
      issue(
        'unsupported-hash-schema-version',
        `unsupported ${label} "${version}"; supported hash schema versions: ${supported.join(', ')}`,
      ),
    )
  }
}

function pushExpiryIssue(
  isoTimestamp: string,
  now: Date,
  label: string,
  errors: FrontierVerificationIssue[],
): void {
  const parsed = Date.parse(isoTimestamp)
  if (Number.isNaN(parsed)) {
    errors.push(issue('invalid-proof-metadata', `${label} expiresAt is not a valid ISO timestamp`))
    return
  }
  if (parsed <= now.getTime()) {
    errors.push(issue('stale-proof', `stale proof: ${label} expired at ${isoTimestamp}`))
  }
}

function pushMaxAgeIssue(
  generatedAt: string,
  maxProofAgeDays: number,
  now: Date,
  errors: FrontierVerificationIssue[],
): void {
  const parsed = Date.parse(generatedAt)
  if (Number.isNaN(parsed)) {
    errors.push(issue('invalid-proof-metadata', 'proof generatedAt is not a valid ISO timestamp'))
    return
  }
  const maxAgeMs = maxProofAgeDays * 24 * 60 * 60 * 1000
  if (now.getTime() - parsed > maxAgeMs) {
    errors.push(
      issue(
        'stale-proof',
        `stale proof: generatedAt ${generatedAt} is older than ${maxProofAgeDays} day(s)`,
      ),
    )
  }
}

function isExpired(isoTimestamp: string | undefined, now: Date): boolean {
  if (!isoTimestamp) return false
  const parsed = Date.parse(isoTimestamp)
  if (Number.isNaN(parsed)) return true
  return parsed <= now.getTime()
}

function normaliseNow(now: Date | string | undefined): Date {
  if (now instanceof Date) return now
  if (typeof now === 'string') {
    const parsed = new Date(now)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function issue(
  code: FrontierIssueCode,
  message: string,
  extra: Partial<Omit<FrontierVerificationIssue, 'code' | 'message'>> = {},
): FrontierVerificationIssue {
  return { code, message, ...extra }
}
