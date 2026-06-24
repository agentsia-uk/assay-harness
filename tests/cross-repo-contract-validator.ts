/**
 * Cross-repo contract validators — consumer side (assay-harness).
 *
 * Mirrors the producer-side schemas in Modelsmith's
 * `src/lib/contracts/cross-repo-registry.ts` (the `assay-release-contract`
 * and `sanitised-scenario` entries). The canonical contract matrix lives in
 * Modelsmith `docs/internal/cross-repo-contracts.md`; that document and
 * `ADR-131 — cross-repo product boundary` govern how these shapes evolve.
 * Future maintainers: read the matrix before changing any field below — the
 * producer and consumer must stay byte-aligned.
 *
 * Contracts covered (consumer of Modelsmith#2081, epic #2077; tracked as
 * assay-harness#11):
 *   - `assay-release-contract` v2 — schemaVersion
 *       "modelsmith.assay-release-contract.v2", emitted by Modelsmith's
 *       `npm run assay:release-contract`.
 *   - `sanitised-scenario` v1 — the elements of
 *       `AssayReleaseContract.scenarios`.
 *
 * Design constraints (issue #11 + sibling PR #10 dependency-minimalism audit):
 *   - NO runtime dependencies. assay-harness is a minimal public Apache-2.0
 *     package, so this is a hand-written strict structural validator — no zod.
 *   - STRICT validation: every required field is presence/type checked, and
 *     ANY unexpected top-level key is rejected. This is the private-scenario-leak
 *     guard called out in the Modelsmith consumer-side-validator-snippet — a
 *     leaked evaluator-only field (`goldSet`, `negativeExamples`,
 *     `expectedFailureModes`, ...) MUST fail validation, never pass through.
 *   - The harness MUST refuse to load a contract whose
 *     `claimGate.status === "blocked"` for any leaderboard-claim run.
 */

/** Raised when a contract or scenario fails strict structural validation. */
export class CrossRepoContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CrossRepoContractError'
  }
}

/** Raised specifically when a blocked contract is used for a leaderboard claim. */
export class ClaimGateBlockedError extends CrossRepoContractError {
  constructor(blocker: string | undefined) {
    super(
      'producer agentsia-uk/Modelsmith emitted an assay-release-contract whose ' +
        'claimGate.status is "blocked"; consumer agentsia-uk/assay-harness refuses ' +
        'to load it for any leaderboard-claim run' +
        (blocker ? ` — blocker: ${blocker}` : '') +
        '. Remediation: re-run `npm run assay:release-contract` in Modelsmith once ' +
        'the claim gate clears, or ingest the corpus only for an internal smoke run.',
    )
    this.name = 'ClaimGateBlockedError'
  }
}

// --- low-level structural assertions -----------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, detail: string): never {
  throw new CrossRepoContractError(
    `cross-repo contract violation at \`${path}\`: ${detail}. ` +
      'producer: agentsia-uk/Modelsmith; consumer: agentsia-uk/assay-harness. ' +
      'See Modelsmith docs/internal/cross-repo-contracts.md (ADR-131).',
  )
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${value === null ? 'null' : typeof value}`)
  }
  return value
}

function requireString(value: unknown, path: string, minLen = 0): string {
  if (typeof value !== 'string') {
    fail(path, `expected a string, got ${value === null ? 'null' : typeof value}`)
  }
  if (value.length < minLen) {
    fail(path, `expected a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail(path, `expected a boolean, got ${value === null ? 'null' : typeof value}`)
  }
  return value
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, `expected a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, got ${JSON.stringify(value)}`)
  }
  return value
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, `expected an array, got ${value === null ? 'null' : typeof value}`)
  }
  value.forEach((item, index) => requireString(item, `${path}[${index}]`))
  return value as string[]
}

/**
 * Reject any key on `obj` that is not in `allowed`. This is the load-bearing
 * private-scenario-leak guard — a permissive passthrough would let a leaked
 * evaluator-only field reach the harness undetected.
 */
function rejectUnexpectedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allow = new Set(allowed)
  for (const key of Object.keys(obj)) {
    if (!allow.has(key)) {
      fail(
        `${path}.${key}`,
        `unexpected key (strict validation rejects unknown fields — possible ` +
          `private-scenario-leak; allowed keys: ${[...allowed].join(', ')})`,
      )
    }
  }
}

// --- sanitised-scenario v1 ----------------------------------------------------

/** Field set mirrored exactly from Modelsmith `SanitizedAssayScenario`. */
const SANITISED_SCENARIO_KEYS = [
  'id',
  'category',
  'description',
  'testObjective',
  'passCriteria',
  'failCriteria',
  'outcomeType',
  'benchmarkTier',
  'multiTurn',
  'conversationHistory',
  'domainInput',
  'consentContext',
  'auctionMechanic',
  'openrtbVersion',
  'specRefs',
  'specVersionPins',
] as const

const BENCHMARK_TIERS = ['public_holdout', 'smoke'] as const

export interface SanitisedScenarioV1 {
  id: string
  category: string
  description: string
  testObjective: string
  passCriteria: string
  failCriteria: string
  outcomeType?: string
  benchmarkTier?: (typeof BENCHMARK_TIERS)[number]
  multiTurn?: boolean
  conversationHistory?: unknown
  domainInput?: unknown
  consentContext?: unknown
  auctionMechanic?: unknown
  openrtbVersion?: unknown
  specRefs?: unknown
  specVersionPins?: unknown
}

/**
 * Strict validator for a single `sanitised-scenario` v1 record. Rejects any
 * unexpected top-level key (private-scenario-leak guard).
 */
export function validateSanitisedScenarioV1(
  value: unknown,
  path = 'sanitisedScenario',
): SanitisedScenarioV1 {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, SANITISED_SCENARIO_KEYS, path)

  const scenario: SanitisedScenarioV1 = {
    id: requireString(obj.id, `${path}.id`, 1),
    category: requireString(obj.category, `${path}.category`),
    description: requireString(obj.description, `${path}.description`),
    testObjective: requireString(obj.testObjective, `${path}.testObjective`),
    passCriteria: requireString(obj.passCriteria, `${path}.passCriteria`),
    failCriteria: requireString(obj.failCriteria, `${path}.failCriteria`),
  }

  if (obj.outcomeType !== undefined) {
    scenario.outcomeType = requireString(obj.outcomeType, `${path}.outcomeType`)
  }
  if (obj.benchmarkTier !== undefined) {
    const tier = requireString(obj.benchmarkTier, `${path}.benchmarkTier`)
    if (!BENCHMARK_TIERS.includes(tier as (typeof BENCHMARK_TIERS)[number])) {
      fail(
        `${path}.benchmarkTier`,
        `expected one of ${BENCHMARK_TIERS.join(', ')}, got ${JSON.stringify(tier)}`,
      )
    }
    scenario.benchmarkTier = tier as (typeof BENCHMARK_TIERS)[number]
  }
  if (obj.multiTurn !== undefined) {
    scenario.multiTurn = requireBoolean(obj.multiTurn, `${path}.multiTurn`)
  }
  // The remaining optional fields are intentionally `unknown` on the producer
  // side too — copy them through verbatim without re-validating shape.
  if (obj.conversationHistory !== undefined)
    scenario.conversationHistory = obj.conversationHistory
  if (obj.domainInput !== undefined) scenario.domainInput = obj.domainInput
  if (obj.consentContext !== undefined) scenario.consentContext = obj.consentContext
  if (obj.auctionMechanic !== undefined) scenario.auctionMechanic = obj.auctionMechanic
  if (obj.openrtbVersion !== undefined) scenario.openrtbVersion = obj.openrtbVersion
  if (obj.specRefs !== undefined) scenario.specRefs = obj.specRefs
  if (obj.specVersionPins !== undefined) scenario.specVersionPins = obj.specVersionPins

  return scenario
}

// --- assay-release-contract v2 ------------------------------------------------

/** Top-level field set mirrored exactly from Modelsmith `AssayReleaseContract`. */
const ASSAY_RELEASE_CONTRACT_KEYS = [
  'schemaVersion',
  'benchmark',
  'corpusVersion',
  'rubricVersion',
  'generatedAt',
  'scenarioSetHash',
  'scenarioSetHashMetadata',
  'publicBundleHash',
  'provenance',
  'rubric',
  'scenarioCounts',
  'harnessDependencyIds',
  'claimGate',
  'scenarios',
] as const

const SCENARIO_SET_HASH_METADATA_KEYS = [
  'hashSchemaVersion',
  'scenarioSetHash',
  'shortHash',
  'scenarioCount',
  'heldOutOnly',
  'governanceNote',
  'dataset',
  'domain',
  'plugin',
  'axes',
  'rubricDescriptors',
  'scoringDescriptors',
  'multiTurn',
  'implementationFingerprints',
  'scorerFingerprints',
  'hashedFields',
  'excludedPrivateFields',
] as const

const SCENARIO_SET_HASH_SCHEMA_VERSIONS = ['v1', 'v2'] as const
const SCENARIO_SET_HASH_DATASET_KEYS = ['name', 'version'] as const
const SCENARIO_SET_PLUGIN_KEYS = ['id', 'version', 'uri'] as const
const SCENARIO_SET_FINGERPRINT_KEYS = ['id', 'version', 'digest', 'uri'] as const
const SCENARIO_SET_MULTITURN_KEYS = [
  'scenarioCount',
  'singleTurnScenarioCount',
  'multiTurnScenarioCount',
  'maxRunnerVisibleTurns',
  'scenarios',
] as const
const SCENARIO_MULTITURN_SHAPE_KEYS = [
  'id',
  'multiTurn',
  'runnerVisibleTurnCount',
  'seedHistoryTurnCount',
  'userTurnCount',
  'persistenceCriteriaCount',
] as const

const PROVENANCE_KEYS = [
  'manifestVersion',
  'selectionRuleHash',
  'publicPrivateSplit',
  'councilRunReference',
] as const

const PUBLIC_PRIVATE_SPLIT_KEYS = ['public', 'private', 'privatePct'] as const
const RUBRIC_KEYS = ['version', 'harnessDependencyIds'] as const
const SCENARIO_COUNTS_KEYS = [
  'totalInManifest',
  'publicExported',
  'privateExcluded',
] as const
const CLAIM_GATE_KEYS = [
  'status',
  'leaderboardClaimsAllowed',
  'blocker',
  'gatedDomains',
] as const

const CLAIM_GATE_STATUSES = ['allowed', 'blocked'] as const

export interface ClaimGateV2 {
  status: (typeof CLAIM_GATE_STATUSES)[number]
  leaderboardClaimsAllowed: boolean
  blocker?: string
  gatedDomains: string[]
}

export interface AssayReleaseContractV2 {
  schemaVersion: 'modelsmith.assay-release-contract.v2'
  benchmark: string
  corpusVersion: string
  rubricVersion: string
  generatedAt: string
  scenarioSetHash: string
  scenarioSetHashMetadata: {
    hashSchemaVersion?: 'v1' | 'v2'
    scenarioSetHash: string
    shortHash?: string
    scenarioCount?: number
    heldOutOnly?: boolean
    governanceNote?: string
    dataset?: { name: string; version: string }
    domain?: string
    plugin?: { id: string; version?: string; uri?: string }
    axes?: string[]
    rubricDescriptors?: string[]
    scoringDescriptors?: string[]
    multiTurn?: {
      scenarioCount: number
      singleTurnScenarioCount: number
      multiTurnScenarioCount: number
      maxRunnerVisibleTurns: number
      scenarios: Array<{
        id: string
        multiTurn: boolean
        runnerVisibleTurnCount: number
        seedHistoryTurnCount: number
        userTurnCount: number
        persistenceCriteriaCount: number
      }>
    }
    implementationFingerprints?: Array<{ id: string; version?: string; digest?: string; uri?: string }>
    scorerFingerprints?: Array<{ id: string; version?: string; digest?: string; uri?: string }>
    hashedFields?: string[]
    excludedPrivateFields?: string[]
  }
  publicBundleHash: string
  provenance: {
    manifestVersion: string
    selectionRuleHash?: string
    publicPrivateSplit: { public: number; private: number; privatePct: number }
    councilRunReference?: unknown
  }
  rubric: { version: string; harnessDependencyIds: string[] }
  scenarioCounts: {
    totalInManifest: number
    publicExported: number
    privateExcluded: number
  }
  harnessDependencyIds: string[]
  claimGate: ClaimGateV2
  scenarios: SanitisedScenarioV1[]
}

const ASSAY_RELEASE_CONTRACT_SCHEMA_VERSION =
  'modelsmith.assay-release-contract.v2' as const

function validateClaimGate(value: unknown, path: string): ClaimGateV2 {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, CLAIM_GATE_KEYS, path)

  const status = requireString(obj.status, `${path}.status`)
  if (!CLAIM_GATE_STATUSES.includes(status as (typeof CLAIM_GATE_STATUSES)[number])) {
    fail(
      `${path}.status`,
      `expected one of ${CLAIM_GATE_STATUSES.join(', ')}, got ${JSON.stringify(status)}`,
    )
  }

  const gate: ClaimGateV2 = {
    status: status as (typeof CLAIM_GATE_STATUSES)[number],
    leaderboardClaimsAllowed: requireBoolean(
      obj.leaderboardClaimsAllowed,
      `${path}.leaderboardClaimsAllowed`,
    ),
    gatedDomains: requireStringArray(obj.gatedDomains, `${path}.gatedDomains`),
  }
  if (obj.blocker !== undefined) {
    gate.blocker = requireString(obj.blocker, `${path}.blocker`)
  }
  return gate
}

function validateScenarioSetPluginIdentity(
  value: unknown,
  path: string,
): { id: string; version?: string; uri?: string } {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, SCENARIO_SET_PLUGIN_KEYS, path)
  const out: { id: string; version?: string; uri?: string } = {
    id: requireString(obj.id, `${path}.id`),
  }
  if (obj.version !== undefined) out.version = requireString(obj.version, `${path}.version`)
  if (obj.uri !== undefined) out.uri = requireString(obj.uri, `${path}.uri`)
  return out
}

function validateScenarioSetFingerprint(
  value: unknown,
  path: string,
): { id: string; version?: string; digest?: string; uri?: string } {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, SCENARIO_SET_FINGERPRINT_KEYS, path)
  const out: { id: string; version?: string; digest?: string; uri?: string } = {
    id: requireString(obj.id, `${path}.id`),
  }
  if (obj.version !== undefined) out.version = requireString(obj.version, `${path}.version`)
  if (obj.digest !== undefined) out.digest = requireString(obj.digest, `${path}.digest`)
  if (obj.uri !== undefined) out.uri = requireString(obj.uri, `${path}.uri`)
  return out
}

function validateScenarioSetFingerprints(
  value: unknown,
  path: string,
): Array<{ id: string; version?: string; digest?: string; uri?: string }> {
  if (!Array.isArray(value)) {
    fail(path, `expected an array, got ${value === null ? 'null' : typeof value}`)
  }
  return value.map((item, index) =>
    validateScenarioSetFingerprint(item, `${path}[${index}]`),
  )
}

function validateScenarioMultiTurnShape(
  value: unknown,
  path: string,
): {
  id: string
  multiTurn: boolean
  runnerVisibleTurnCount: number
  seedHistoryTurnCount: number
  userTurnCount: number
  persistenceCriteriaCount: number
} {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, SCENARIO_MULTITURN_SHAPE_KEYS, path)
  return {
    id: requireString(obj.id, `${path}.id`),
    multiTurn: requireBoolean(obj.multiTurn, `${path}.multiTurn`),
    runnerVisibleTurnCount: requireNonNegativeInt(
      obj.runnerVisibleTurnCount,
      `${path}.runnerVisibleTurnCount`,
    ),
    seedHistoryTurnCount: requireNonNegativeInt(
      obj.seedHistoryTurnCount,
      `${path}.seedHistoryTurnCount`,
    ),
    userTurnCount: requireNonNegativeInt(obj.userTurnCount, `${path}.userTurnCount`),
    persistenceCriteriaCount: requireNonNegativeInt(
      obj.persistenceCriteriaCount,
      `${path}.persistenceCriteriaCount`,
    ),
  }
}

function validateScenarioSetMultiTurn(
  value: unknown,
  path: string,
): AssayReleaseContractV2['scenarioSetHashMetadata']['multiTurn'] {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, SCENARIO_SET_MULTITURN_KEYS, path)
  if (!Array.isArray(obj.scenarios)) {
    fail(`${path}.scenarios`, `expected an array, got ${obj.scenarios === null ? 'null' : typeof obj.scenarios}`)
  }
  return {
    scenarioCount: requireNonNegativeInt(obj.scenarioCount, `${path}.scenarioCount`),
    singleTurnScenarioCount: requireNonNegativeInt(
      obj.singleTurnScenarioCount,
      `${path}.singleTurnScenarioCount`,
    ),
    multiTurnScenarioCount: requireNonNegativeInt(
      obj.multiTurnScenarioCount,
      `${path}.multiTurnScenarioCount`,
    ),
    maxRunnerVisibleTurns: requireNonNegativeInt(
      obj.maxRunnerVisibleTurns,
      `${path}.maxRunnerVisibleTurns`,
    ),
    scenarios: obj.scenarios.map((item, index) =>
      validateScenarioMultiTurnShape(item, `${path}.scenarios[${index}]`),
    ),
  }
}

function validateScenarioSetHashMetadataV2(
  metaObj: Record<string, unknown>,
  metadata: AssayReleaseContractV2['scenarioSetHashMetadata'],
  path: string,
): void {
  const datasetObj = requireObject(
    metaObj.dataset,
    `${path}.scenarioSetHashMetadata.dataset`,
  )
  rejectUnexpectedKeys(
    datasetObj,
    SCENARIO_SET_HASH_DATASET_KEYS,
    `${path}.scenarioSetHashMetadata.dataset`,
  )
  metadata.dataset = {
    name: requireString(datasetObj.name, `${path}.scenarioSetHashMetadata.dataset.name`),
    version: requireString(
      datasetObj.version,
      `${path}.scenarioSetHashMetadata.dataset.version`,
    ),
  }
  metadata.domain = requireString(metaObj.domain, `${path}.scenarioSetHashMetadata.domain`)
  metadata.plugin = validateScenarioSetPluginIdentity(
    metaObj.plugin,
    `${path}.scenarioSetHashMetadata.plugin`,
  )
  metadata.axes = requireStringArray(metaObj.axes, `${path}.scenarioSetHashMetadata.axes`)
  metadata.rubricDescriptors = requireStringArray(
    metaObj.rubricDescriptors,
    `${path}.scenarioSetHashMetadata.rubricDescriptors`,
  )
  metadata.scoringDescriptors = requireStringArray(
    metaObj.scoringDescriptors,
    `${path}.scenarioSetHashMetadata.scoringDescriptors`,
  )
  metadata.multiTurn = validateScenarioSetMultiTurn(
    metaObj.multiTurn,
    `${path}.scenarioSetHashMetadata.multiTurn`,
  )
  metadata.implementationFingerprints = validateScenarioSetFingerprints(
    metaObj.implementationFingerprints,
    `${path}.scenarioSetHashMetadata.implementationFingerprints`,
  )
  metadata.scorerFingerprints = validateScenarioSetFingerprints(
    metaObj.scorerFingerprints,
    `${path}.scenarioSetHashMetadata.scorerFingerprints`,
  )
  metadata.hashedFields = requireStringArray(
    metaObj.hashedFields,
    `${path}.scenarioSetHashMetadata.hashedFields`,
  )
  metadata.excludedPrivateFields = requireStringArray(
    metaObj.excludedPrivateFields,
    `${path}.scenarioSetHashMetadata.excludedPrivateFields`,
  )
}

/**
 * Strict validator for an `assay-release-contract` v2 document. Rejects any
 * unexpected top-level (and nested-object) key. Does NOT enforce the claim
 * gate — call {@link assertLeaderboardClaimAllowed} (or pass
 * `{ forLeaderboardClaim: true }` to {@link loadAssayReleaseContractV2}) for
 * that.
 */
export function validateAssayReleaseContractV2(
  value: unknown,
  path = 'assayReleaseContract',
): AssayReleaseContractV2 {
  const obj = requireObject(value, path)
  rejectUnexpectedKeys(obj, ASSAY_RELEASE_CONTRACT_KEYS, path)

  const schemaVersion = requireString(obj.schemaVersion, `${path}.schemaVersion`)
  if (schemaVersion !== ASSAY_RELEASE_CONTRACT_SCHEMA_VERSION) {
    fail(
      `${path}.schemaVersion`,
      `expected literal "${ASSAY_RELEASE_CONTRACT_SCHEMA_VERSION}", got ` +
        `${JSON.stringify(schemaVersion)} — rotate-version-string contracts must ` +
        `keep a v2 fixture until the deprecation window closes`,
    )
  }

  const metaObj = requireObject(
    obj.scenarioSetHashMetadata,
    `${path}.scenarioSetHashMetadata`,
  )
  rejectUnexpectedKeys(
    metaObj,
    SCENARIO_SET_HASH_METADATA_KEYS,
    `${path}.scenarioSetHashMetadata`,
  )
  const metadata: AssayReleaseContractV2['scenarioSetHashMetadata'] = {
    scenarioSetHash: requireString(
      metaObj.scenarioSetHash,
      `${path}.scenarioSetHashMetadata.scenarioSetHash`,
      1,
    ),
  }
  if (metaObj.hashSchemaVersion !== undefined) {
    const hashSchemaVersion = requireString(
      metaObj.hashSchemaVersion,
      `${path}.scenarioSetHashMetadata.hashSchemaVersion`,
    )
    if (!SCENARIO_SET_HASH_SCHEMA_VERSIONS.includes(hashSchemaVersion as 'v1' | 'v2')) {
      fail(
        `${path}.scenarioSetHashMetadata.hashSchemaVersion`,
        `unknown scenario-set hash schema version ${JSON.stringify(hashSchemaVersion)}`,
      )
    }
    metadata.hashSchemaVersion = hashSchemaVersion as 'v1' | 'v2'
  }
  if (metaObj.shortHash !== undefined) {
    metadata.shortHash = requireString(
      metaObj.shortHash,
      `${path}.scenarioSetHashMetadata.shortHash`,
    )
  }
  if (metaObj.scenarioCount !== undefined) {
    metadata.scenarioCount = requireNonNegativeInt(
      metaObj.scenarioCount,
      `${path}.scenarioSetHashMetadata.scenarioCount`,
    )
  }
  if (metaObj.heldOutOnly !== undefined) {
    metadata.heldOutOnly = requireBoolean(
      metaObj.heldOutOnly,
      `${path}.scenarioSetHashMetadata.heldOutOnly`,
    )
  }
  if (metaObj.governanceNote !== undefined) {
    metadata.governanceNote = requireString(
      metaObj.governanceNote,
      `${path}.scenarioSetHashMetadata.governanceNote`,
    )
  }
  if (metadata.hashSchemaVersion === 'v2') {
    validateScenarioSetHashMetadataV2(metaObj, metadata, path)
  }

  const provObj = requireObject(obj.provenance, `${path}.provenance`)
  rejectUnexpectedKeys(provObj, PROVENANCE_KEYS, `${path}.provenance`)
  const splitObj = requireObject(
    provObj.publicPrivateSplit,
    `${path}.provenance.publicPrivateSplit`,
  )
  rejectUnexpectedKeys(
    splitObj,
    PUBLIC_PRIVATE_SPLIT_KEYS,
    `${path}.provenance.publicPrivateSplit`,
  )
  const provenance: AssayReleaseContractV2['provenance'] = {
    manifestVersion: requireString(
      provObj.manifestVersion,
      `${path}.provenance.manifestVersion`,
      1,
    ),
    publicPrivateSplit: {
      public: requireNonNegativeInt(
        splitObj.public,
        `${path}.provenance.publicPrivateSplit.public`,
      ),
      private: requireNonNegativeInt(
        splitObj.private,
        `${path}.provenance.publicPrivateSplit.private`,
      ),
      privatePct: requireNumber(
        splitObj.privatePct,
        `${path}.provenance.publicPrivateSplit.privatePct`,
      ),
    },
  }
  if (provObj.selectionRuleHash !== undefined) {
    provenance.selectionRuleHash = requireString(
      provObj.selectionRuleHash,
      `${path}.provenance.selectionRuleHash`,
    )
  }
  if (provObj.councilRunReference !== undefined) {
    provenance.councilRunReference = provObj.councilRunReference
  }

  const rubricObj = requireObject(obj.rubric, `${path}.rubric`)
  rejectUnexpectedKeys(rubricObj, RUBRIC_KEYS, `${path}.rubric`)

  const countsObj = requireObject(obj.scenarioCounts, `${path}.scenarioCounts`)
  rejectUnexpectedKeys(countsObj, SCENARIO_COUNTS_KEYS, `${path}.scenarioCounts`)

  if (!Array.isArray(obj.scenarios)) {
    fail(`${path}.scenarios`, 'expected an array')
  }
  const scenarios = (obj.scenarios as unknown[]).map((scenario, index) =>
    validateSanitisedScenarioV1(scenario, `${path}.scenarios[${index}]`),
  )

  return {
    schemaVersion: ASSAY_RELEASE_CONTRACT_SCHEMA_VERSION,
    benchmark: requireString(obj.benchmark, `${path}.benchmark`, 1),
    corpusVersion: requireString(obj.corpusVersion, `${path}.corpusVersion`, 1),
    rubricVersion: requireString(obj.rubricVersion, `${path}.rubricVersion`, 1),
    generatedAt: requireString(obj.generatedAt, `${path}.generatedAt`, 1),
    scenarioSetHash: requireString(obj.scenarioSetHash, `${path}.scenarioSetHash`, 1),
    scenarioSetHashMetadata: metadata,
    publicBundleHash: requireString(
      obj.publicBundleHash,
      `${path}.publicBundleHash`,
      1,
    ),
    provenance,
    rubric: {
      version: requireString(rubricObj.version, `${path}.rubric.version`, 1),
      harnessDependencyIds: requireStringArray(
        rubricObj.harnessDependencyIds,
        `${path}.rubric.harnessDependencyIds`,
      ),
    },
    scenarioCounts: {
      totalInManifest: requireNonNegativeInt(
        countsObj.totalInManifest,
        `${path}.scenarioCounts.totalInManifest`,
      ),
      publicExported: requireNonNegativeInt(
        countsObj.publicExported,
        `${path}.scenarioCounts.publicExported`,
      ),
      privateExcluded: requireNonNegativeInt(
        countsObj.privateExcluded,
        `${path}.scenarioCounts.privateExcluded`,
      ),
    },
    harnessDependencyIds: requireStringArray(
      obj.harnessDependencyIds,
      `${path}.harnessDependencyIds`,
    ),
    claimGate: validateClaimGate(obj.claimGate, `${path}.claimGate`),
    scenarios,
  }
}

// --- corpus-identity uniqueness (Tier-1 #2) -----------------------------------

/**
 * Raised when a single corpus version tag resolves to more than one
 * (scenarioCount, scenarioSetHash) identity. A version tag MUST pin a unique
 * corpus, otherwise two consumers can both publish "the v1.8.0-rc.4 score" off
 * different scenario sets.
 */
export class CorpusIdentityCollisionError extends CrossRepoContractError {
  constructor(version: string, identities: CorpusIdentity[]) {
    super(
      `corpus version "${version}" resolves to ${identities.length} distinct ` +
        `(scenarioCount, scenarioSetHash) identities: ` +
        identities
          .map((i) => `${i.scenarioCount ?? '?'}/${i.scenarioSetHash.slice(0, 12)}`)
          .join(' vs ') +
        `. A version tag must pin a UNIQUE corpus. Either bump the version of ` +
        `the divergent corpus, or mark a non-corpus document as a shape-only ` +
        `fixture (see isShapeOnlyContract).`,
    )
    this.name = 'CorpusIdentityCollisionError'
  }
}

export interface CorpusIdentity {
  version: string
  scenarioSetHash: string
  scenarioCount?: number
}

/**
 * A contract is a SHAPE-ONLY fixture (a schema example, not a real corpus
 * identity) when its inline `scenarios` array is smaller than the public
 * scenario count it declares. The byte-aligned v2 example fixture carries the
 * 296/`4fc9` corpus identity in its counts/hash for producer-consumer schema
 * alignment, but ships only a couple of illustrative scenarios inline — it is
 * NOT a competing corpus and must be excluded from the uniqueness check.
 *
 * The discriminator is structural (count vs inline length), so a freshly cut,
 * fully-populated contract is never mistaken for a shape fixture.
 */
export function isShapeOnlyContract(contract: AssayReleaseContractV2): boolean {
  return contract.scenarios.length < contract.scenarioCounts.publicExported
}

/**
 * Assert that a set of real (non-shape) corpus contracts maps each version tag
 * to a UNIQUE (scenarioCount, scenarioSetHash). Throws
 * {@link CorpusIdentityCollisionError} on the first colliding version.
 *
 * Shape-only fixtures are skipped (see {@link isShapeOnlyContract}).
 */
export function assertCorpusIdentityUniqueness(
  contracts: readonly AssayReleaseContractV2[],
): void {
  const byVersion = new Map<string, CorpusIdentity[]>()
  for (const contract of contracts) {
    if (isShapeOnlyContract(contract)) continue
    const identity: CorpusIdentity = {
      version: contract.corpusVersion,
      scenarioSetHash: contract.scenarioSetHash,
      scenarioCount: contract.scenarioSetHashMetadata.scenarioCount,
    }
    const bucket = byVersion.get(identity.version) ?? []
    bucket.push(identity)
    byVersion.set(identity.version, bucket)
  }

  for (const [version, identities] of byVersion) {
    const distinct = new Map(
      identities.map((i) => [`${i.scenarioCount}:${i.scenarioSetHash}`, i]),
    )
    if (distinct.size > 1) {
      throw new CorpusIdentityCollisionError(version, [...distinct.values()])
    }
  }
}

/**
 * Refuse a contract whose claim gate is blocked. Call this before using a
 * contract for ANY leaderboard-claim run. A blocked contract MAY still be
 * ingested for an internal smoke run (do not call this for that path).
 */
export function assertLeaderboardClaimAllowed(
  contract: AssayReleaseContractV2,
): void {
  if (contract.claimGate.status === 'blocked') {
    throw new ClaimGateBlockedError(contract.claimGate.blocker)
  }
}

export interface LoadOptions {
  /**
   * When true, the contract is being loaded for a leaderboard-claim run, so a
   * `claimGate.status === "blocked"` contract is hard-refused. When false (the
   * default), the gate is not enforced — suitable for internal smoke runs.
   */
  forLeaderboardClaim?: boolean
}

/**
 * Parse-and-validate entry point. Accepts an already-parsed JSON value (the
 * mirrored fixture is imported via `resolveJsonModule`), runs the strict
 * structural validator, and — when `forLeaderboardClaim` is set — refuses a
 * blocked claim gate.
 */
export function loadAssayReleaseContractV2(
  value: unknown,
  options: LoadOptions = {},
): AssayReleaseContractV2 {
  const contract = validateAssayReleaseContractV2(value)
  if (options.forLeaderboardClaim) {
    assertLeaderboardClaimAllowed(contract)
  }
  return contract
}
