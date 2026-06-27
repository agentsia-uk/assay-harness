# Changelog

## Unreleased

Donation-readiness preparation for IAB Tech Lab handover.

- Added security, contributing, code-of-conduct, maintainer, and notice files.
- Updated README and package metadata to state that `assay-harness` is an
  Agentsia-originated project prepared for donation to IAB Tech Lab.
- Documented GitHub release tarballs as the current distribution path and marked
  the package private so npm publication remains disabled.
- Added `prepack` so local package tarballs build `dist/` before packing.
- Updated production dependencies and workspace overrides to clear known
  moderate advisories in `@anthropic-ai/sdk` and transitive `protobufjs`.

## v0.5.1 - 2026-06-24

Docs and storefront patch for the expanded frontier snapshot.

- Updated the Assay-Adtech SVG from three bars to the seven-row frontier
  snapshot shown in the latest Modelsmith protocol analysis.
- Marked Fable 5 as provisional because its source row is a single
  grandfathered protocol-analysis run.
- Trimmed README wording so `assay-harness` remains presented as a
  corpus-agnostic runner, scorer, and proof verifier while benchmark-specific
  leaderboard claims stay tied to release contracts.

## v0.5.0 - 2026-06-24

This is a minor harness release for the Modelsmith-grade public benchmarking
upgrade. It changes the reusable package surface; it does not rotate the
Assay-Adtech v1 public benchmark artifact bundle, which remains pinned to the
v0.4.0 release assets and their release contract.

### Added

- First-class multi-turn CLI execution with persistence grading metadata in
  `RunRecord.meta.multiTurn`.
- Scenario-set hash schema v2 metadata for public-safe corpus identity,
  including runner-visible input, rubric descriptors, multi-turn shape, and
  scorer or implementation fingerprints.
- Public proof-bundle manifest generation with checksums, claim-gate state,
  runner metadata, aggregate results, and reproducibility self-test status.
- Fail-closed frontier proof verification for claim gate, scenario-set hash,
  hash schema, provider quorum, and optional freshness policy.
- Paired-bootstrap compare intervals in the compare CLI and comparison API.
- Public scenario methodology diagnostics for outcome coverage, lane coverage,
  prompt duplication, near-duplication, training-prompt leakage, weak rubrics,
  item difficulty, and plugin-supplied release checks.
- Scorer conformance fingerprints and persistence evidence-validity predicates.

### Changed

- README and package metadata now distinguish the latest harness/package
  release from the Assay-Adtech v1 benchmark artifact bundle.
- Package metadata now includes storefront keywords for evaluation,
  reproducibility, Modelsmith, and frontier benchmarking use cases.

### Release Assessment

This warrants a minor version because the public CLI, exported TypeScript API,
and package metadata gained new benchmark-governance capabilities. It is not a
benchmark-data release: users should continue to download the Assay-Adtech v1
public release contract, public harness export, and checksums from v0.4.0 until
Modelsmith publishes a new artifact bundle.

## v0.4.0 - 2026-05-21

Initial public harness release for Assay-Adtech v1.

- Stable public CLI, runner interface, rubric contract, and `RunRecord` shape.
- Provider runners for Anthropic, OpenAI, Google Gemini without grounding,
  Hugging Face Inference, local vLLM, and deterministic stubs.
- Assay-Adtech v1 public release assets:
  `assay-adtech-v1.8.0-rc.4-release-contract.json`,
  `assay-adtech-v1.8.0-rc.4-public-harness-export.json`, and
  `assay-adtech-v1.8.0-rc.4-assets.sha256`.
