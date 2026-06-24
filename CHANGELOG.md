# Changelog

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
