#!/usr/bin/env npx tsx
/**
 * Cross-repo contract validator for Assay-Harness.
 *
 * Reads Modelsmith's cross-repo release contract and verifies that the
 * Assay-Harness quality-baseline row does not claim gates absent from this
 * repository's deployed CI. This is the sibling-side adoption hook required by
 * agentsia-uk/Modelsmith#3953 before Modelsmith can flip the ratchet to
 * fail-closed mode.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_SLUG = 'agentsia-uk/Assay-Harness';
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const CANDIDATE_CONTRACT_PATHS = [
  path.resolve(SCRIPT_DIR, '../../Modelsmith/config/cross-repo-release-contract.json'),
  path.resolve(SCRIPT_DIR, '../../../Modelsmith/config/cross-repo-release-contract.json'),
  path.resolve(SCRIPT_DIR, '../../../Modelsmith/Modelsmith/config/cross-repo-release-contract.json'),
  path.resolve(SCRIPT_DIR, '../../priv/Modelsmith/config/cross-repo-release-contract.json'),
];

const GATE_DEPLOYMENT_SIGNALS: Record<string, RegExp[]> = {
  lint: [/\b(?:npm run|pnpm(?: run)?|yarn(?: run)?)\s+lint\b/, /\beslint\b/, /\bbiome\s+(?:lint|check)\b/],
  typecheck: [
    /\b(?:npm run|pnpm(?: run)?|yarn(?: run)?)\s+(?:typecheck|type-check)\b/,
    /\btsc\b\s*(?:--noEmit|--build|-b|\n|$)/,
  ],
  'secrets-scan': [/shared-secrets-scan\.yml/, /\bgitleaks\b/],
  'dependency-audit': [/\b(?:npm|pnpm|yarn)\s+audit(?![:\w-])/, /\bpip-audit\b/],
};

type QualityBaselineRepo = {
  secretsScanVersion?: string;
  satisfies?: string[];
};

type Contract = {
  qualityBaseline?: {
    requiredGates?: string[];
    secretsScan?: {
      version?: string;
    };
    repos?: Record<string, QualityBaselineRepo>;
  };
};

function parseArgs(): string {
  let contractPath = CANDIDATE_CONTRACT_PATHS.find((p) => existsSync(p)) ?? CANDIDATE_CONTRACT_PATHS[0]!;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === '--contract') {
      contractPath = process.argv[++i] ?? contractPath;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npx tsx scripts/validate-cross-repo-contract.ts [--contract <path>]');
      process.exit(0);
    }
  }
  return contractPath;
}

function readWorkflowText(): string {
  const workflowDir = path.join(REPO_ROOT, '.github', 'workflows');
  return readdirSync(workflowDir)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .map((entry) => readFileSync(path.join(workflowDir, entry), 'utf8'))
    .join('\n');
}

function deployedGate(workflowText: string, gate: string): boolean {
  return (GATE_DEPLOYMENT_SIGNALS[gate] ?? []).some((signal) => signal.test(workflowText));
}

function main(): void {
  const contractPath = parseArgs();
  const errors: string[] = [];
  const warnings: string[] = [];
  const workflowText = readWorkflowText();

  if (!existsSync(contractPath)) {
    errors.push(
      `Modelsmith cross-repo contract not found at ${contractPath}; Assay-Harness must validate against an authoritative contract read before Modelsmith#3953 can flip fail-closed`,
    );
    report(errors, warnings);
    return;
  }

  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as Contract;
  const qualityBaseline = contract.qualityBaseline;
  const assayRow = qualityBaseline?.repos?.[REPO_SLUG];
  if (!qualityBaseline || !assayRow) {
    errors.push(`qualityBaseline.repos is missing ${REPO_SLUG}`);
    report(errors, warnings);
    return;
  }

  const satisfies = new Set(assayRow.satisfies ?? []);
  for (const gate of satisfies) {
    if (!deployedGate(workflowText, gate)) {
      errors.push(
        `${REPO_SLUG} contract declares qualityBaseline.satisfies '${gate}' but Assay-Harness CI does not run it`,
      );
    }
  }

  for (const gate of qualityBaseline.requiredGates ?? []) {
    if (!satisfies.has(gate) && deployedGate(workflowText, gate)) {
      warnings.push(
        `${REPO_SLUG} CI runs '${gate}' but Modelsmith qualityBaseline.satisfies does not yet record it`,
      );
    }
  }

  const ciGitleaks = workflowText.match(/gitleaks-version:\s*["']?([^"'\s]+)["']?/)?.[1];
  const contractGitleaks = qualityBaseline.secretsScan?.version;
  if (ciGitleaks && contractGitleaks && ciGitleaks !== contractGitleaks) {
    errors.push(`gitleaks version drift: Assay-Harness CI=${ciGitleaks} Modelsmith contract=${contractGitleaks}`);
  }
  if (assayRow.secretsScanVersion && contractGitleaks && assayRow.secretsScanVersion !== contractGitleaks) {
    errors.push(
      `Assay-Harness secretsScanVersion=${assayRow.secretsScanVersion} but shared contract version=${contractGitleaks}`,
    );
  }
  if (!/validate-cross-repo-contract|pnpm(?: run)?\s+contracts:cross-repo/.test(workflowText)) {
    errors.push('Assay-Harness CI must run the cross-repo contract validator');
  }

  report(errors, warnings);
}

function report(errors: string[], warnings: string[]): void {
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length === 0) {
    console.log(`cross-repo quality contract ok for ${REPO_SLUG}`);
    return;
  }
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

main();
