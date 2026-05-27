# assay-harness

Open evaluation harness for the [Agentsia Labs](https://agentsia.uk/labs) benchmark series.

`assay-harness` is the public runner and scoring package used around Agentsia Labs benchmark releases. It loads harness-native scenario datasets, sends prompts to provider or local model runners, evaluates outputs against published rubrics, and writes versioned `RunRecord` JSON for audit and aggregation.

The first live benchmark is **Assay-Adtech v1**. Its governed release currently contains 344 scenarios in Modelsmith, with 113 public scenarios exported for inspection and reproducibility work. The remaining 231 scenarios are private holdout items used for leaderboard integrity.

![Assay-Adtech frontier performance chart](docs/assets/assay-adtech-frontier-performance.svg)

## Status

**v0.4.0, 2026-05.** Anthropic, OpenAI, Google Gemini without grounding, Hugging Face Inference, local vLLM, and deterministic stub runners are implemented. The public TypeScript types, CLI shape, runner interface, release-contract validator, and `RunRecord` output format are stable for the Assay-Adtech v1 release cycle.

The GitHub source archive intentionally contains only the harness source and tiny sample scenarios. Assay-Adtech benchmark artifacts are attached to the release as explicit assets:

- [Release contract](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-release-contract.json)
- [Public harness export](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-public-harness-export.json)
- [Asset checksums](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-assets.sha256)

## Get Started

1. Install Node 22 or later and pnpm.

   ```bash
   corepack enable
   pnpm install
   ```

2. Confirm the harness CLI can read the bundled sample dataset.

   ```bash
   pnpm assay list examples/scenarios
   ```

   Expected output:

   ```text
   example v0.0.0 (2 scenarios)
     001-echo-hello  [echo]
     002-non-empty  [format]
   ```

3. Run the deterministic sample end to end.

   ```bash
   pnpm assay run \
     --dataset examples/scenarios \
     --runner stub:echo \
     --out runs/local.json
   ```

`runs/local.json` is a `RunRecord` containing the raw model responses, per-scenario scores, aggregate scores, harness version, and command line.

4. Run a real provider model by setting the relevant key and choosing a runner id.

   ```bash
   export ANTHROPIC_API_KEY="..."
   pnpm assay run \
     --dataset examples/scenarios \
     --runner anthropic:claude-opus-4-7 \
     --out runs/claude-sample.json
   ```

   Other runner prefixes are `openai:`, `google:`, `hf:`, and `vllm:`.

5. Download the Assay-Adtech v1 public artifacts.

   ```bash
   mkdir -p artifacts/assay-adtech-v1.8.0-rc.4
   gh release download v0.4.0 \
     --repo agentsia-uk/assay-harness \
     --dir artifacts/assay-adtech-v1.8.0-rc.4 \
     --pattern 'assay-adtech-v1.8.0-rc.4-*'
   ```

6. Verify the release assets.

   ```bash
   cd artifacts/assay-adtech-v1.8.0-rc.4
   shasum -a 256 -c assay-adtech-v1.8.0-rc.4-assets.sha256
   ```

7. Inspect the public benchmark export.

   ```bash
   node -e "const fs=require('fs'); const p='assay-adtech-v1.8.0-rc.4-public-harness-export.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(j.metadata); console.log(j.scenarios.length)"
   ```

   The public export should report 113 scenarios for scenario-set hash `162ff7fcd8ce`. The release contract reports the governed corpus size, private-exclusion count, claim gate, and redaction boundary.

## What Is In Scope

This repo provides:

- The `assay` CLI for listing and running harness-native datasets.
- Provider runners for Anthropic, OpenAI, Google Gemini, Hugging Face, local vLLM, and deterministic stubs.
- Core public types for `Scenario`, `Runner`, `ModelResponse`, `Score`, `ModelAggregate`, and `RunRecord`.
- Programmatic rubric scoring, aggregate computation, serialization, and strict Modelsmith release-contract validators.
- Tiny examples that show the dataset shape without embedding benchmark holdout content in the source archive.

This repo does not contain:

- The private scenario-generation pipeline. That lives in Modelsmith.
- The private Assay-Adtech holdout scenarios.
- Agentsia model training code or customer Modelsmith code.
- Scraping, Playwright automation, VPN or proxy rotation, or data-ingestion machinery.

## Assay-Adtech V1 Artifacts

Assay-Adtech v1 release artifacts are governed by Modelsmith and published here as public release assets.

| Artifact | Meaning |
|---|---|
| `assay-adtech-v1.8.0-rc.4-release-contract.json` | Release contract for the governed corpus. Includes corpus counts, scenario-set hash, claim gate, and public redaction contract. |
| `assay-adtech-v1.8.0-rc.4-public-harness-export.json` | Public scenario export. Contains the 113 public scenarios and excludes 231 private holdout scenarios. |
| `assay-adtech-v1.8.0-rc.4-assets.sha256` | Checksums for the release assets. |

Current release contract facts:

| Field | Value |
|---|---|
| Manifest version | `1.8.0-rc.4` |
| Scenario-set hash | `162ff7fcd8ce4266af8848938b3fc6415000843e0901651456d3fa4191fc65b6` |
| Governed scenarios | 344 |
| Public scenarios | 113 |
| Private holdout scenarios excluded | 231 |
| Public outcome distribution | TP 36, TN 28, FP-guard 21, FN-guard 28 |

The benchmark claims page and release contract should be treated as the public source of truth for Assay-Adtech leaderboard claims. The sample files under `examples/scenarios` are only smoke-test fixtures for the harness package.

## Frontier Baseline Snapshot

The SVG above is derived from the current Modelsmith production-baseline proof package for scenario-set hash `162ff7fcd8ce`. It summarizes no-tools frontier runs over the 344-scenario governed corpus.

| Benchmark cluster | Claude Opus 4.7 | GPT 5.5 | Gemini 3.1 Pro Preview |
|---|---:|---:|---:|
| Assay-Adtech | 41.6 | 40.4 | 37.2 |

Scores are composite percentages against a 100 percent ceiling. Each provider row is based on three production runs with 95 percent confidence intervals recorded in the proof package. Use the release contract before quoting any leaderboard or performance claim.

## Concepts

| Term | Meaning |
|---|---|
| **Scenario** | One test case with prompt input, axes, rubric, and metadata. |
| **Runner** | A provider-specific adapter that submits a scenario prompt and returns a `ModelResponse`. |
| **Rubric** | The scoring contract for a scenario. Current implementation supports programmatic rubrics. LLM-judge and human rubrics are typed and reserved for release-specific evaluators. |
| **Score** | A normalized 0-to-1 value for one runner on one scenario and one axis. |
| **Axis** | A capability dimension published for a benchmark, such as bid-shading judgement or RTB-payload parsing. |
| **Composite** | Weighted average across axes. Weights are published alongside the benchmark release. |
| **RunRecord** | Top-level output with dataset version, runners, responses, scores, aggregates, and run metadata. |

## Runners

| Runner id | Provider | Environment |
|---|---|---|
| `anthropic:*` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `openai:*` | OpenAI Chat Completions API | `OPENAI_API_KEY` |
| `google:*` | Google Gemini API without grounding | `GOOGLE_API_KEY` |
| `hf:*` | Hugging Face Inference endpoint | Optional `HF_TOKEN` |
| `vllm:*` | Local vLLM server, OpenAI-compatible | Optional `VLLM_BASE_URL`, optional `VLLM_API_KEY` |
| `stub:echo` | Deterministic test runner returning the prompt | none |
| `stub:empty` | Deterministic empty-output test runner | none |

Each runner records provider, model, server-reported version where available, temperature, access timestamp, latency, and provider metadata in every `ModelResponse`.

## Rubrics

Programmatic rubrics are implemented in `src/rubric.ts` and can be extended with `registerChecker()`. Built-in checkers:

- `exact-match`
- `contains`
- `non-empty`

The public type surface also defines `llm-judge` and `human` rubric variants. Programmatic rubrics remain the default for benchmark-grade claims. LLM judges require an explicit executor, calibration evidence, prompt provenance, and passing bias checks before the harness will score them. Their scores default to `analysis-only` so they cannot silently become leaderboard claims. Human annotations are represented through a validation and adjudication contract that can export preference pairs for downstream Modelsmith training workflows.

## Statistical Claim Gates

`aggregate()` can attach deterministic bootstrap confidence intervals to per-axis aggregates when callers provide a confidence configuration. `comparePairedScores()` reports paired bootstrap intervals for model A versus model B on the same scenario set. Use paired intervals when deciding whether a candidate model has genuinely improved over a baseline. Small deltas without interval support should be treated as descriptive, not as a promotion claim.

## Scenario Diagnostics

`analyseScenarioItems()` reports item-level pass rates, outcome-type coverage, and possible leakage when scenario prompts overlap known training prompts. `compareScenarioSets()` reports added, removed, changed, and suspiciously overlapping scenarios between dataset versions. These diagnostics are intended to help Modelsmith decide whether to generate new training scenarios, revise weak eval items, or block contaminated training data.

## Interoperability

`exportInspectRunRecord()` and `exportLmEvaluationSummary()` convert native Assay records into external-eval-friendly shapes for Inspect and lm-evaluation-harness style workflows. Native Assay records remain the source of truth because they preserve scenario hashes, privacy classification, scorer metadata, and Modelsmith release boundaries.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm audit:deadcode
```

CI runs typecheck, tests, build, and dead-code audit for every PR.

### Dead-Code And Dependency Audit

`assay-harness` is intentionally small, public, and package-oriented. Every exported runner, dependency, and type becomes part of the public maintenance surface. `pnpm audit:deadcode` runs [`knip`](https://knip.dev) as a static-analysis pass with no provider API keys and no network. It reports:

- source files not reachable from `src/index.ts`, the CLI, scripts, or tests
- exported symbols that are not part of the intentional public API
- runtime dependencies with no live implementation
- unused devDependencies.

When you add a provider runner:

1. Export its factory from `src/runners/index.ts` and re-export it from `src/index.ts`.
2. Wire the provider into `resolveRunner()` so the CLI can dispatch to it.
3. Add the provider SDK to `dependencies` only if a runner imports it at runtime.
4. Keep new dependencies justified for a public Apache-2.0 package.

## Reproducibility

Every published Assay release should identify:

- the scenario-set hash and release contract
- the harness version
- the model ids, access timestamps, and run settings
- raw or redacted run records where publication policy allows
- aggregate scores and confidence intervals
- claim-gate status

If a published public artifact cannot be verified against its checksum, file an issue.

## Contributing

Issues and pull requests are welcome. For substantive changes such as a new runner, new rubric type, scoring-logic change, or release-contract field change, open an issue first so the producer and consumer contracts stay aligned.

## Licensing

Apache 2.0. See `LICENSE`.

## Citation

If you cite Agentsia Labs numbers, cite the specific benchmark release and scenario-set hash. The repo is the tool. The benchmark release is the claim.

## Related

- [Assay-Adtech v1 benchmark page](https://agentsia.uk/labs/benchmarks/assay-adtech-v1)
- [Agentsia Labs](https://agentsia.uk/labs)
- [Agentsia](https://agentsia.uk)
