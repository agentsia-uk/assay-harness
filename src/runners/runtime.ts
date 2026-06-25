import { createRequire } from 'node:module'

import type { RunnerOptions } from '../types.js'

export const PROVIDER_RUNTIME_SCHEMA_VERSION = 'assay-harness.provider-runtime.v1'

export interface ToolPolicyMetadata {
  tools: 'disabled' | 'not-supported'
  grounding: 'disabled' | 'not-supported'
  webSearch: 'disabled' | 'not-supported'
  note?: string
}

export interface SdkMetadata {
  name: string
  packageName?: string
  version?: string | null
}

export interface TokenUsageMetadata {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface SafeRuntimeExtra {
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
}

export interface PreparedRunnerRuntime {
  runnerId: string
  provider: string
  route: string
  requestedModel: string
  timeoutMs?: number
  safeExtra: SafeRuntimeExtra
  forwardedExtraKeys: string[]
  sdk?: SdkMetadata
  toolPolicy: ToolPolicyMetadata
}

export interface PrepareRunnerRuntimeArgs {
  runnerId: string
  provider: string
  route: string
  requestedModel: string
  opts: RunnerOptions
  supportedExtraKeys?: readonly SafeRuntimeExtraKey[]
  sdk?: SdkMetadata
  toolPolicy: ToolPolicyMetadata
}

export interface BuildRuntimeMetadataArgs {
  runtime: PreparedRunnerRuntime
  temperature?: number
  seed?: number
  maxTokens?: number
  reportedModel?: string | null
  tokenUsage?: TokenUsageMetadata
  costUsd?: number | null
  endpoint?: string
}

export type SafeRuntimeExtraKey = keyof SafeRuntimeExtra

const SUPPORTED_EXTRA_KEYS: readonly SafeRuntimeExtraKey[] = [
  'maxTokens',
  'topP',
  'stopSequences',
]

const UNSAFE_EXTRA_KEY_PATTERN = /(tool|function|ground|search|web|response[_-]?format)/i

const require = createRequire(import.meta.url)
const packageVersionCache = new Map<string, string | null>()

export function prepareRunnerRuntime(args: PrepareRunnerRuntimeArgs): PreparedRunnerRuntime {
  validateTimeoutMs(args.runnerId, args.opts.timeoutMs)
  const supportedExtraKeys = args.supportedExtraKeys ?? SUPPORTED_EXTRA_KEYS
  const safeExtra = readSafeExtra(args.runnerId, args.opts.extra, supportedExtraKeys)

  return {
    runnerId: args.runnerId,
    provider: args.provider,
    route: args.route,
    requestedModel: args.requestedModel,
    ...(args.opts.timeoutMs !== undefined ? { timeoutMs: args.opts.timeoutMs } : {}),
    safeExtra,
    forwardedExtraKeys: Object.keys(safeExtra),
    ...(args.sdk ? { sdk: args.sdk } : {}),
    toolPolicy: args.toolPolicy,
  }
}

export async function withRunnerTimeout<T>(
  operation: () => Promise<T>,
  runtime: PreparedRunnerRuntime,
  scenarioId: string,
  operationName: string,
): Promise<T> {
  if (runtime.timeoutMs === undefined) return operation()

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(
        new RunnerTimeoutError(
          `[${runtime.runnerId}] ${operationName} timed out after ` +
            `${runtime.timeoutMs}ms for scenario "${scenarioId}"`,
        ),
      )
    }, runtime.timeoutMs)

    operation().then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class RunnerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerTimeoutError'
  }
}

export function buildRuntimeMetadata(args: BuildRuntimeMetadataArgs): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (args.temperature !== undefined) options['temperature'] = args.temperature
  if (args.seed !== undefined) options['seed'] = args.seed
  if (args.maxTokens !== undefined) options['maxTokens'] = args.maxTokens
  if (args.runtime.safeExtra.topP !== undefined) options['topP'] = args.runtime.safeExtra.topP
  if (args.runtime.safeExtra.stopSequences !== undefined) {
    options['stopSequences'] = args.runtime.safeExtra.stopSequences
  }

  const metadata: Record<string, unknown> = {
    schemaVersion: PROVIDER_RUNTIME_SCHEMA_VERSION,
    provider: args.runtime.provider,
    route: args.runtime.route,
    requestedModel: args.runtime.requestedModel,
    reportedModel: args.reportedModel ?? null,
    timeoutMs: args.runtime.timeoutMs ?? null,
    timedOut: false,
    forwardedExtraKeys: args.runtime.forwardedExtraKeys,
    options,
    toolPolicy: args.runtime.toolPolicy,
  }
  if (args.runtime.sdk) metadata['sdk'] = withResolvedSdkVersion(args.runtime.sdk)
  if (args.tokenUsage) metadata['tokenUsage'] = args.tokenUsage
  if (args.costUsd !== undefined) {
    metadata['cost'] = { currency: 'USD', total: args.costUsd }
  }
  if (args.endpoint) metadata['endpoint'] = args.endpoint
  return metadata
}

export function defaultSdkMetadata(name: string, packageName = name): SdkMetadata {
  return {
    name,
    packageName,
    version: packageVersion(packageName),
  }
}

function validateTimeoutMs(runnerId: string, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`[${runnerId}] RunnerOptions.timeoutMs must be a positive finite number`)
  }
}

function readSafeExtra(
  runnerId: string,
  extra: RunnerOptions['extra'],
  supportedKeys: readonly SafeRuntimeExtraKey[],
): SafeRuntimeExtra {
  if (extra === undefined) return {}
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    throw new Error(`[${runnerId}] RunnerOptions.extra must be an object when provided`)
  }

  const supported = new Set<string>(supportedKeys)
  const unsupported = Object.keys(extra).filter((key) => !supported.has(key))
  if (unsupported.length > 0) {
    const unsafe = unsupported.filter((key) => UNSAFE_EXTRA_KEY_PATTERN.test(key))
    const supportedText = supportedKeys.length > 0 ? supportedKeys.join(', ') : 'none'
    const unsafeText =
      unsafe.length > 0
        ? ' Tool, function, grounding, web-search, and response-format options are intentionally disabled for benchmark runners.'
        : ''
    throw new Error(
      `[${runnerId}] unsupported RunnerOptions.extra key(s): ${unsupported.join(', ')}. ` +
        `Supported keys: ${supportedText}.${unsafeText}`,
    )
  }

  const safe: SafeRuntimeExtra = {}
  if (Object.hasOwn(extra, 'maxTokens')) safe.maxTokens = readPositiveInteger(extra['maxTokens'], 'maxTokens', runnerId)
  if (Object.hasOwn(extra, 'topP')) safe.topP = readTopP(extra['topP'], runnerId)
  if (Object.hasOwn(extra, 'stopSequences')) {
    safe.stopSequences = readStopSequences(extra['stopSequences'], runnerId)
  }
  return safe
}

function readPositiveInteger(value: unknown, key: string, runnerId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[${runnerId}] RunnerOptions.extra.${key} must be a positive finite number`)
  }
  return Math.floor(value)
}

function readTopP(value: unknown, runnerId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`[${runnerId}] RunnerOptions.extra.topP must be a number between 0 and 1`)
  }
  return value
}

function readStopSequences(value: unknown, runnerId: string): string[] {
  const sequences = typeof value === 'string' ? [value] : value
  if (
    !Array.isArray(sequences) ||
    sequences.length === 0 ||
    !sequences.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(
      `[${runnerId}] RunnerOptions.extra.stopSequences must be a non-empty string or string array`,
    )
  }
  return sequences
}

function withResolvedSdkVersion(sdk: SdkMetadata): SdkMetadata {
  if (sdk.version !== undefined) return sdk
  if (!sdk.packageName) return sdk
  return { ...sdk, version: packageVersion(sdk.packageName) }
}

function packageVersion(packageName: string): string | null {
  const cached = packageVersionCache.get(packageName)
  if (cached !== undefined) return cached
  try {
    const pkg = require(`${packageName}/package.json`) as { version?: unknown }
    const version = typeof pkg.version === 'string' ? pkg.version : null
    packageVersionCache.set(packageName, version)
    return version
  } catch {
    packageVersionCache.set(packageName, null)
    return null
  }
}
