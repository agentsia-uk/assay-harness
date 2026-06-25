# Proof Bundle Format

`assay proof build` emits a deterministic JSON manifest for public release proof
bundles. `assay proof verify` checks that manifest against the private source
artifacts held by the producer, and `assay proof replay` deterministically
replays pinned outputs for golden fixtures. The manifest is designed for
Modelsmith and Agentsia Labs consumers that need to verify benchmark identity,
checksums, runner metadata, claim-gate state, and aggregate results without
receiving private answer keys.

## Command

```bash
pnpm assay proof build \
  --run runs/frontier-run.json \
  --contract artifacts/assay-adtech-release-contract.json \
  --dataset artifacts/public-harness-export.json \
  --out artifacts/assay-proof.json

pnpm assay proof verify artifacts/assay-proof.json \
  --run runs/frontier-run.json \
  --contract artifacts/assay-adtech-release-contract.json \
  --dataset artifacts/public-harness-export.json \
  --leaderboard-eligible \
  --claim-card artifacts/claim-card.json

pnpm assay proof replay \
  --run runs/golden-pinned-run.json \
  --contract artifacts/assay-adtech-release-contract.json \
  --dataset artifacts/public-harness-export.json \
  --proof artifacts/assay-proof.json
```

`--dataset` is optional, but recommended. When supplied, the proof builder
recomputes the scenario-set hash from the dataset and checks it against the
`RunRecord` and release contract.

`--trace-bundle` can be supplied to `proof build`, `proof verify`, or `proof
replay` when environment-backed runs need proof-side trace validation. The proof
manifest stores only a checksum for that bundle; verification fails closed if the
manifest declares a trace checksum and the trace bundle is missing or mismatched.
`--json` on `proof verify` or `proof replay` emits machine-readable pass/fail
details.

## Manifest Shape

The top-level `schemaVersion` is `assay.proof-bundle.v1`. All checksums use:

```json
{
  "algorithm": "sha256",
  "digestEncoding": "hex",
  "canonicalization": "assay-json-canonical-v1",
  "checksumFormat": "sha256:<hex>"
}
```

Objects are canonicalized by recursively sorting object keys before hashing.
Arrays preserve their source order unless the field is explicitly documented as
sorted, such as runner metadata by `runnerId`.

Key fields:

| Field | Meaning |
|---|---|
| `releaseContractHash` | SHA-256 checksum of the canonical release contract JSON. |
| `scenarioSetHash` | Effective scenario-set hash plus the values seen in the run record, release contract, and optional dataset. |
| `claimGate` | Public claim status from the release contract: `allowed`, `blocked`, or `unknown`. |
| `run` | Run id, dataset id/version, creation time, harness version, counts, and redacted run command line. |
| `releaseContract` | Public-safe release-contract summary. The inline scenario list, pass criteria, and fail criteria are not copied into the proof. |
| `runnerMetadata` | Provider/model/version/settings summaries, response counts, latency summary, and access timestamp range per runner. |
| `publicResults` | Aggregate scores and confidence intervals from the `RunRecord`. |
| `proofIndex` | Checksummed entries that make up the proof bundle. |
| `checksums.traceBundle` | Optional checksum for an environment trace bundle supplied out-of-band. |
| `reproducibilitySelfTest` | Status and check details for schema validation, checksum recomputation, scenario-hash consistency, and canonical output determinism. |

## Privacy Boundary

The proof manifest does not include scenario prompts, private holdout answer
keys, pass/fail criteria, raw model outputs, or per-scenario scores. It includes
checksums of the canonical redacted `RunRecord` and the release contract so a
holder of the source artifacts can verify provenance without publishing the
private evaluation material.

Command lines are redacted before publication. Secret-like flags such as
`--api-key`, `--token`, `--secret`, `--password`, `--auth`, and `--credential`
have their values replaced with `[REDACTED]`; common token prefixes such as
`sk-`, `Bearer`, `ghp_`, `ghs_`, and Slack `xox*` tokens are also redacted.

## Claim Gate Semantics

`claimGate.status` is copied into the proof even when it is `blocked`. A blocked
claim gate does not make the proof invalid: it means the bundle is public
evidence that leaderboard or release claims must not be quoted until the
producer-side release contract is regenerated with an allowed gate.

Consumers should treat `reproducibilitySelfTest.status === "passed"` as proof
that the bundle is internally consistent, and `claimGate.status === "allowed"`
as the separate authorization signal for public leaderboard claims.

For leaderboard-eligible proof verification, pass `--leaderboard-eligible` and
`--claim-card`. This uses the same `assertRunClaimEligible()` gate as publish
and fails closed for blocked, stale, malformed, or analysis-only claim material.
