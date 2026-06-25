export * from './types.js'
export { loadDataset } from './loader.js'
export {
  score,
  registerChecker,
  validateHumanAnnotations,
  annotationsToPreferencePairs,
} from './rubric.js'
export {
  containsUnnegatedMatch,
  literalPhrase,
  tokenPresent,
  NEGATION_WINDOW_CHARS,
} from './matchers.js'
export type { StringMatcherMode } from './matchers.js'
export {
  scoreMechanism,
  coerceCriteria,
  MECHANISM_SCORER_VERSION,
  MECHANISM_SCORER_FINGERPRINT,
  MECHANISM_GATE_WEIGHTS,
  ANTI_BINGO_CAP,
  MECHANISM_PASS_THRESHOLD,
  FRONTIER_QUORUM_REQUIRED,
  FRONTIER_QUORUM_TOTAL,
} from './mechanism.js'
export type { MechanismCriteria, MechanismGate, MechanismScore } from './mechanism.js'
export {
  assertFrontierQuorum,
  formatFrontierVerificationResult,
  readFrontierContractMetadata,
  verifyFrontierQuorum,
  DEFAULT_FRONTIER_HASH_SCHEMA_VERSION,
  FRONTIER_PROOF_SCHEMA_VERSION,
  SUPPORTED_FRONTIER_HASH_SCHEMA_VERSIONS,
  FrontierVerificationError,
} from './frontier.js'
export type {
  FrontierClaimGate,
  FrontierContractMetadata,
  FrontierHashIdentity,
  FrontierIssueCode,
  FrontierProofMetadata,
  FrontierProviderProofCell,
  FrontierQuorumOptions,
  FrontierQuorumResult,
  FrontierVerificationIssue,
} from './frontier.js'
export { aggregate, comparePairedScores } from './aggregator.js'
export {
  analyseScenarioItems,
  auditScenarioSet,
  compareScenarioSets,
  createMetadataFreshnessPlugin,
  formatScenarioAuditReport,
} from './diagnostics.js'
export type {
  DiagnosticSeverity,
  MetadataFreshnessPluginOptions,
  ScenarioDiagnosticFinding,
  ScenarioDiagnosticKind,
  ScenarioDiagnosticsPlugin,
  ScenarioDiagnosticsPluginContext,
  ScenarioDiagnosticsPluginFinding,
  ScenarioSetAuditOptions,
  ScenarioSetAuditReport,
} from './diagnostics.js'
export { exportInspectRunRecord, exportLmEvaluationSummary } from './interoperability.js'
export {
  writeRunRecord,
  readRunRecord,
  newRunId,
  computeScenarioSetHash,
  computeScenarioSetHashBySchema,
  computeScenarioSetHashV2,
  SCENARIO_SET_HASH_SCHEMA_V1,
  SCENARIO_SET_HASH_SCHEMA_V2,
  SCENARIO_SET_HASH_V2_HASHED_FIELDS,
  SCENARIO_SET_HASH_V2_EXCLUDED_PRIVATE_FIELDS,
  UnknownScenarioSetHashSchemaError,
} from './serialiser.js'
export type { ComputeScenarioSetHashBySchemaOptions } from './serialiser.js'
export { pooled } from './concurrency.js'
export { withJudgeCache } from './judge-cache.js'
export type { JudgeCacheOptions } from './judge-cache.js'
export { compareRuns, formatCompareTable } from './compare.js'
export type {
  CompareResult,
  ReliabilityDelta,
  ScenarioComparison,
  SliceDelta,
} from './compare.js'
export { buildMarkdownReport, createGist } from './publish.js'
export type { GistResult } from './publish.js'
export {
  buildProofBundleManifest,
  buildProofBundleManifestFromFiles,
  canonicalJson,
  checksumObject,
  formatProofBundleManifest,
  validateProofBundleManifest,
  writeProofBundleManifest,
  PROOF_BUNDLE_SCHEMA_VERSION,
  PROOF_HASH_SCHEMA,
} from './proof.js'
export type {
  BuildProofBundleManifestFromFilesOptions,
  BuildProofBundleManifestOptions,
  ProofBundleManifest,
  ProofBundleValidationResult,
  ProofIndexEntry,
  ProofSelfTestCheck,
  ReleaseContractSummary,
  RunnerProofMetadata,
  ValidateProofBundleInputs,
} from './proof.js'
export {
  aggregateConfidenceErrors,
  assertRunClaimEligible,
  validateRunRecord,
  assertValidRunRecord,
  assertScenarioSetHashMatches,
  assertScenarioStratificationPublishable,
  validateClaimCard,
  ClaimEligibilityError,
  ScenarioSetHashMismatchError,
  ScenarioStratificationPublicationError,
  REQUIRED_OUTCOME_TYPES,
} from './validate.js'
export type {
  ClaimEligibilityOptions,
  ValidationResult,
  StratificationGuardOptions,
} from './validate.js'
export { withRetry } from './retry.js'
export { createStderrLogger, createNullLogger } from './progress.js'
export type { ProgressEvent, ProgressLogger } from './progress.js'
export {
  resolveRunner,
  createStubRunner,
  createAnthropicRunner,
  createOpenAIRunner,
  createGoogleRunner,
  createHuggingFaceRunner,
  createVllmRunner,
} from './runners/index.js'
export {
  runMultiTurn,
  assertSingleTurn,
  isMultiTurnScenario,
  validateMultiTurnScenario,
  MultiTurnError,
} from './runners/multi-turn.js'
export type {
  MultiTurnScenario,
  MultiTurnResult,
  ConversationTurn,
  MultiTurnValidationOptions,
} from './runners/multi-turn.js'
export {
  gradePersistence,
  scorePersistence,
  PERSISTENCE_GRADER_VERSION,
  PERSISTENCE_GRADER_FINGERPRINT,
  PERSISTENCE_EVIDENCE_VALIDITY_PREDICATE_ID,
  PERSISTENCE_CRITERION_KINDS,
  evaluatePersistenceEvidenceValidity,
  isPersistenceEvidenceValid,
} from './persistence-grader.js'
export type {
  TurnObservation,
  PersistenceCriterion,
  PersistenceScore,
  PersistenceVerdict,
  PersistenceReason,
  FactPersistenceCriterion,
  DispositionPersistenceCriterion,
  ConstraintPersistenceCriterion,
  MechanismPersistenceCriterion,
  EvidenceUpdateCriterion,
  PersistenceEvidenceReference,
  PersistenceEvidenceValidity,
  PersistenceEvidenceValidityOptions,
  PersistenceEvidenceValidityReason,
} from './persistence-grader.js'
