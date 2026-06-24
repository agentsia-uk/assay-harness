# assay-harness

Open evaluation harness for the [Agentsia Labs](https://agentsia.uk/labs) benchmark series.

`assay-harness` is the public runner and scoring package used around Agentsia Labs benchmark releases. It loads harness-native scenario datasets, sends prompts to provider or local model runners, evaluates outputs against published rubrics, and writes versioned `RunRecord` JSON for audit and aggregation.

The scoring mechanism is public and reproducible. The executable scorer enforces the published scoring rules rather than leaving them as prose: it caps keyword-bingo so a response cannot win on vocabulary alone, and it matches negation-aware so "this is **not** invalid traffic" is not credited as if it had flagged invalid traffic. The mechanism is a scoring *rule*, not an answer key. See [Reproducibility](#reproducibility) for the golden self-test that proves a headline number regenerates, and [`docs/public-held-out-boundary.md`](docs/public-held-out-boundary.md) for exactly what is released versus held out.

The first live benchmark is **Assay-Adtech v1**. The governed corpus size, the public/private split, and the scenario-set hash are reported by the release contract, which is the single source of truth for those numbers (see [Assay-Adtech V1 Artifacts](#assay-adtech-v1-artifacts)). The private holdout scenarios are excluded from the public export and exist for leaderboard integrity; they are disclosed as excluded, never silently folded into a public composite.

![Assay-Adtech frontier performance chart](docs/assets/assay-adtech-frontier-performance.svg)

## Status

**v0.4.0, 2026-05.** Anthropic, OpenAI, Google Gemini without grounding, Hugging Face Inference, local vLLM, and deterministic stub runners are implemented. The public TypeScript types, CLI shape, runner interface, release-contract validator, and `RunRecord` output format are stable for the Assay-Adtech v1 release cycle.

The GitHub source archive intentionally contains only the harness source and tiny sample scenarios. Assay-Adtech benchmark artifacts are attached to the release as explicit assets:

- [Release contract](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-release-contract.json)
- [Public harness export](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-public-harness-export.json)
- [Asset checksums](https://github.com/agentsia-uk/assay-harness/releases/download/v0.4.0/assay-adtech-v1.8.0-rc.4-assets.sha256)

## Get Started

1. Install Node 22 or later and use the pnpm version pinned by Corepack.

   ```bash
   corepack enable
   corepack install
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
| `assay-adtech-v1.8.0-rc.4-public-harness-export.json` | Public scenario export. Contains the public scenarios and excludes the private holdout scenarios. |
| `assay-adtech-v1.8.0-rc.4-assets.sha256` | Checksums for the release assets. |

The governed corpus size, the public/private split, the public outcome distribution, the scenario-set hash, and the manifest version are reported **by the release contract**, which is the single source of truth for those numbers. Read them from the contract rather than from this README, so a copy here can never drift from the artifact:

```bash
node -e "const j=require('./assay-adtech-v1.8.0-rc.4-release-contract.json'); console.log({manifest:j.provenance.manifestVersion, hash:j.scenarioSetHash, counts:j.scenarioCounts, split:j.provenance.publicPrivateSplit, claimGate:j.claimGate.status})"
```

A `RunRecord` is bound to the `scenarioSetHash` it was produced against, so a number is always tied to the exact corpus it was measured on and cannot be quoted against a different one. The benchmark claims page and release contract are the public source of truth for Assay-Adtech leaderboard claims. The sample files under `examples/scenarios` are only smoke-test fixtures for the harness package.

New producers should publish schema-v2 hash metadata alongside the bare hash.
Schema v2 binds dataset/domain/plugin identity, runner-visible input, axes,
rubric/scoring descriptors, multi-turn shape, and public-safe implementation or
scorer fingerprints without embedding private answer-key fields. See
[`docs/scenario-set-hash-v2.md`](docs/scenario-set-hash-v2.md).

## Public Proof Bundles

`assay proof build` creates a deterministic public proof manifest for a
`RunRecord` plus release contract:

```bash
pnpm assay proof build \
  --run runs/frontier-run.json \
  --contract artifacts/assay-adtech-release-contract.json \
  --dataset artifacts/public-harness-export.json \
  --out artifacts/assay-proof.json
```

The proof includes checksums, hash schema, scenario-set hash, release-contract
hash, claim-gate status, runner metadata, redacted command line, aggregate
results, and reproducibility self-test status. It does not copy private answer
keys, pass/fail criteria, raw outputs, or per-scenario scores. See
[`docs/proof-bundle-format.md`](docs/proof-bundle-format.md) for the full
format.

## Frontier Baseline Snapshot

The SVG above is derived from the published, version-labelled Modelsmith **v1.0** production-baseline proof package for the governed 344-scenario corpus, hash `04e0063373df`. It summarizes no-tools frontier runs over that corpus. These are the only Assay-Adtech frontier numbers cleared for leaderboard reference today.

| Benchmark cluster | Claude Opus 4.7 | GPT 5.5 | Gemini 3.5 Flash |
|---|---:|---:|---:|
| Assay-Adtech | 41.6 | 40.4 | 38.1 |

Scores are composite percentages against a 100 percent ceiling. Each provider row is based on three production runs with 95 percent confidence intervals recorded in the proof package (Opus 4.7 36.3 to 46.8; GPT 5.5 35.2 to 45.6; Gemini 3.5 Flash 32.8 to 43.3). Use the release contract before quoting any leaderboard or performance claim.

A number is always tied to the exact corpus hash it was measured on. The v1.0 baselines above stay published and version-labelled per the benchmark-versioning policy. The corpus has since rotated to **v1.1** (hash `0c3bafc0f150`) after a council grader-rebuild and factual-correction pass; the release contract's `claimGate` keeps leaderboard claims **blocked** on v1.1 until the runnable frontier models are re-run on that hash. No v1.1 number is published here.

**Frontier lineup.** The frontier panel Modelsmith tracks for Assay-Adtech spans Claude (Opus 4.7, Opus 4.8, Fable 5), OpenAI (GPT 5.5, GPT 5.4), and Google Gemini (3.5 Flash, 3.1 Pro Preview). Only the three corpus-matched, quorum-satisfied v1.0 cells above carry published leaderboard scores. **Claude Fable 5** is part of the lineup but does not yet have a corpus-matched, leaderboard-eligible score: its only run to date is a single grandfathered pass on a superseded pre-fact-check corpus revision, so quoting that number against the published v1.0 or current v1.1 hash would violate the corpus-matching rule. A corpus-matched Fable 5 run on the current governed hash is the follow-up before a leaderboard cell is shown.

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

### Mechanism Scorer And Anti-Bingo

The built-in `contains` checker is a plain substring match. On its own a substring match credits keyword-bingo: a true-positive item keyed on `["invalid traffic", "flag"]` would score a full mark for "this is **not** invalid traffic, do **not** flag", which is the opposite of the right answer. So `contains` is capped at the anti-bingo ceiling unless the rubric explicitly marks `smokeTestOnly: true`; it is for smoke-test fixtures, not benchmark-grade scoring. Benchmark-grade scoring uses the executable mechanism scorer, which caps the credit a response can earn from vocabulary alone and matches negation-aware (a phrase inside a locally-negated clause does not count). The persistence grader described below reuses that same negation-aware matcher. The scorer is bound to a scorer version so a score is reproducible against a known scoring rule. Exposing this rule is deliberate; it is a scoring mechanism, not an answer key, and the per-held-out-scenario phrase expansions stay private (see [`docs/public-held-out-boundary.md`](docs/public-held-out-boundary.md)).

### Multi-Turn And Persistence

Some scenarios are multi-turn: they submit a sequence of adversarial user turns and check whether the model holds its position across them rather than caving to pressure. The release contract advertises these via `multiTurn` / `conversationHistory` and a `persistence-grader-v1` harness dependency. The harness ships that grader (`runMultiTurn` plus `gradePersistence` / `scorePersistence` in `src/persistence-grader.ts`): it walks the conversation, accumulating history per turn, then grades persistence (did the model carry a fact, disposition, constraint, or mechanism forward; did it correctly update on legitimate new evidence). The matcher is the same negation-aware one the mechanism scorer uses, so "I will **not** approve the refund" is not scored as a flip. A scenario marked multi-turn is refused on the single-shot path rather than silently flattened to its first turn.

## Statistical Claim Gates

`aggregate()` can attach deterministic bootstrap confidence intervals to per-axis aggregates when callers provide a confidence configuration. `comparePairedScores()` reports paired bootstrap intervals for model A versus model B on the same scenario set. Use paired intervals when deciding whether a candidate model has genuinely improved over a baseline. Small deltas without interval support should be treated as descriptive, not as a promotion claim.

## Scenario Diagnostics

`analyseScenarioItems()` reports item-level pass rates, outcome-type coverage, and possible leakage when scenario prompts overlap known training prompts. `compareScenarioSets()` reports added, removed, changed, and suspiciously overlapping scenarios between dataset versions. These diagnostics are intended to help Modelsmith decide whether to generate new training scenarios, revise weak eval items, or block contaminated training data.

`auditScenarioSet()` is the broader public methodology audit. It is domain-generic: the core reads public scenario metadata such as `meta.outcomeType` and lane metadata, while release-specific checks can be supplied as `ScenarioDiagnosticsPlugin` instances. The built-in `createMetadataFreshnessPlugin()` is a generic plugin helper for metadata such as `meta.domainFacts`; adtech-specific stale-fact policy still belongs outside the core package.

The CLI exposes the same report in readable and JSON forms:

```bash
pnpm assay diagnostics examples/scenarios
pnpm assay diagnostics path/to/public-export.json --json
pnpm assay diagnostics path/to/public-export.json \
  --training-prompts path/to/training-prompts.txt \
  --required-outcome tp --required-outcome tn \
  --required-outcome fp-guard --required-outcome fn-guard \
  --required-lane bid-floor --required-lane pmp \
  --fail-on-claim-blocking
```

Diagnostics are labelled by claim impact:

| Diagnostic | Default impact | Why |
|---|---|---|
| Missing `meta.outcomeType` or missing caller-required outcome type | Claim-blocking | Public benchmark claims require explicit outcome stratification. |
| Missing caller-required lane | Claim-blocking | A required methodology lane is absent from the published scenario set. |
| Missing lane metadata with no caller-required lane policy | Advisory | It weakens auditability but may be acceptable for tiny examples. |
| Identical duplicate prompts | Claim-blocking | Duplicate items can distort scenario counts and composite claims. |
| Near-duplicate prompts | Advisory | Similar prompts need review, but a domain owner may intentionally vary a prompt family. |
| Leakage against supplied training prompts | Claim-blocking | Contaminated scenarios should not support public claims. |
| `non-empty` or smoke-only/sign-blind `contains` rubrics | Claim-blocking | Smoke checkers exercise harness plumbing rather than benchmark-grade scoring. |
| Too-easy / too-hard scored items | Advisory | They guide item revision but do not prove the scenario is invalid. |
| Plugin findings such as stale domain facts | Plugin-defined | Domain freshness windows are release policy, so plugins choose advisory or claim-blocking severity. |

## Interoperability

`exportInspectRunRecord()` and `exportLmEvaluationSummary()` convert native Assay records into external-eval-friendly shapes for Inspect and lm-evaluation-harness style workflows. Native Assay records remain the source of truth because they preserve scenario hashes, privacy classification, scorer metadata, and Modelsmith release boundaries.

## Development

```bash
pnpm install
pnpm contracts:cross-repo
pnpm typecheck
pnpm test
pnpm build
pnpm audit:deadcode
```

CI runs the cross-repo contract check, typecheck, tests, build, and dead-code audit for every PR on Node 22 with the pinned pnpm version.

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

What makes the headline reproducible rather than merely asserted is the **golden reproducibility self-test**: a pinned corpus plus pinned model outputs are scored in CI, and the regenerated composite must equal the published value. Because the scoring mechanism is public (the anti-bingo cap and negation-aware matcher, the persistence grader), anyone can run the same pinned inputs through the same scorer and land on the same number. A score that cannot be regenerated from pinned inputs and the public scorer is not a reproducible score, and should not be quoted as one.

Released versus held-out is drawn explicitly in [`docs/public-held-out-boundary.md`](docs/public-held-out-boundary.md). Released scenarios are reproducibly scorable from this repo. Held-out scenarios are disclosed as held out and never silently mixed into a public composite. Judge-mediated components are disclosed as judge-mediated and default to `analysis-only`.

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
