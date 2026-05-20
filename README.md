# assay-harness

Open evaluation harness for the [Agentsia Labs](https://labs.agentsia.uk) benchmark series.

`assay-harness` is the scoring pipeline behind every Agentsia Labs release. It loads a scenario dataset, runs it through one or more model runners (frontier APIs, open-weights inference endpoints, local vLLM), evaluates outputs against a published rubric, and writes versioned, reproducible results.

Anyone can use this harness to reproduce Agentsia Labs numbers, or to score their own models against our published datasets, without involving Agentsia.

## Status

**v0.4.0 · 2026-04 · Every adapter live.** The public surface (types, CLI shape, runner interface, rubric contract, output format) is stable. Anthropic Messages API, OpenAI Chat Completions, Google Gemini (no grounding), Hugging Face Inference, and local vLLM adapters are all implemented. Harness is ready for the inaugural Agentsia Labs benchmark, Assay-Adtech v1, targeted Q2 2026.

## Scope

Evaluation execution only. This repo does not contain:

- The synthetic scenario-generation pipeline that authors Assay datasets. That lives inside Modelsmith.
- The post-training pipeline used to build Agentsia specialist models.
- Any customer or commercial Modelsmith code.

The separation is deliberate. Assay datasets, the harness, and the leaderboards are fully open. The generator and the training pipeline are the commercial surface of the Agentsia platform. Both are referenced by the methodology page at [labs.agentsia.uk/methodology](https://labs.agentsia.uk/methodology).

## Install

```bash
pnpm install
```

Requires Node 22 or later.

## Run

```bash
# List the bundled sample scenarios
pnpm assay list examples/scenarios

# Score a dataset against a single runner
pnpm assay run \
  --dataset examples/scenarios \
  --runner stub:echo \
  --out runs/local.json

# Score across multiple runners
pnpm assay run \
  --dataset examples/scenarios \
  --runner anthropic:claude-opus-4-7 \
  --runner openai:gpt-6 \
  --runner google:gemini-3-pro \
  --out runs/cross.json
```

Each runner emits a `ModelResponse` per scenario. A `Rubric` attached to each scenario converts the response to a `Score`. The aggregator collapses scores into per-axis summaries and a weighted composite. Output is serialised as JSON, versioned against the dataset SHA and the harness release tag.

## Concepts

| Term | Meaning |
|---|---|
| **Scenario** | One test case: prompt input, expected rubric, capability axis label, and scenario metadata. Serialised as JSON. |
| **Runner** | A provider-specific adapter that submits a scenario prompt and returns a `ModelResponse` with version, timestamp, latency, and generation settings. |
| **Rubric** | The scoring contract for a scenario. Three kinds: programmatic (structural checker), LLM-as-judge (reference-matched), human (panel review). |
| **Score** | A 0-to-1 value for one runner on one scenario on one axis, with optional rationale. |
| **Axis** | A capability dimension published for a benchmark (e.g. bid-shading judgement, pre-bid MFA filtering, RTB-payload parsing). |
| **Composite** | Weighted average across axes. Weights are published alongside the release with a rationale. |
| **RunRecord** | Top-level output: the dataset version, the runners evaluated, every `Score`, and every `ModelAggregate`. |

## Runners

| Runner id | Provider | Implementation status |
|---|---|---|
| `anthropic:*` | Anthropic Messages API | implemented (v0.2) |
| `openai:*` | OpenAI Chat Completions API | implemented (v0.3) |
| `google:*` | Google Gemini API (no grounding) | implemented (v0.4) |
| `hf:*` | Hugging Face Inference endpoint | implemented (v0.4) |
| `vllm:*` | Local vLLM server (OpenAI-compatible) | implemented (v0.4) |
| `stub:echo` | Returns the prompt verbatim; deterministic; used for tests | implemented |
| `stub:empty` | Returns the empty string; deterministic; used for failure-mode tests | implemented |

Each runner discloses: `provider`, `model`, `version`, `temperature`, `systemPrompt`, `accessedAt`, `latencyMs`. These travel with every `ModelResponse` and are serialised into the `RunRecord`.

## Rubrics (planned)

- **Programmatic.** Deterministic checker; the correct output is structurally decidable (schema match, value equality, computed predicate). Implemented as a small TypeScript function.
- **LLM-as-judge.** A pinned judge model scores the response against a reference. Judge model id is disclosed in the release; inter-judge agreement is published when multiple judges are used.
- **Human.** Panel-reviewed scoring surfaced through a thin annotation interface. Not in v0.

## Reproducibility

Every published Assay release produces:

- The scenario dataset at a specific git tag (Apache 2.0)
- The harness version (git tag on this repo)
- The reproduction command (a single `assay run` invocation)
- The raw `RunRecord` JSON with per-response outputs
- The leaderboard computed from the `RunRecord`

If a user cannot reproduce a published number within reported variance by running the command on the published artefacts, that is a bug. File an issue.

## Variance and seeds

Every score is run three times with different sampling seeds (temperature 0 where permitted; 0.2 otherwise). Variance is reported alongside the mean. Small deltas between runners in high-variance regimes are explicitly flagged in the release, not treated as ranked.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm audit:deadcode
```

CI runs on GitHub Actions for every PR: typecheck, test, build, and the
dead-code audit.

### Dead-code and dependency-minimalism audit

`assay-harness` is intentionally small, public, and package-oriented: every
exported runner, dependency, and type becomes part of the public maintenance
surface. To keep that surface honest, `pnpm audit:deadcode` runs
[`knip`](https://knip.dev) as a pure static-analysis pass — no provider API
keys, no network — that reports:

- source files not reachable from `src/index.ts`, the CLI, `scripts/`, or tests;
- exported symbols that are not part of the intentional public API;
- runtime dependencies (including provider SDKs) with no live implementation;
- unused devDependencies.

Configuration lives in `knip.json`. The command exits non-zero on any finding,
and CI runs it after `pnpm build`.

**Classifying a new runner or dependency.** When you add a provider runner:

1. Export its factory (`create<Provider>Runner`) from `src/runners/index.ts`
   and re-export it from `src/index.ts` so it is part of the public API and
   reachable by the audit.
2. Wire the provider into `resolveRunner()` so the CLI can dispatch to it.
3. Add the provider SDK to `dependencies` only if a runner imports it at
   runtime — knip will flag an SDK with no live runner as an unused
   dependency, and a runner with no SDK import does not justify the dependency.
4. New dependencies must be justified for a public Apache-2.0 harness: prefer
   the official provider SDK, keep the dependency tree shallow, and avoid
   pulling heavyweight transitive dependencies into a published package.

If `knip` reports a genuine intentional public-API export that has no internal
consumer, keep it reachable from `src/index.ts` (the package entry) rather than
silencing it; `knip.json` uses `ignoreExportsUsedInFile` so re-exports stay
clean. Add a targeted `ignore`/`ignoreDependencies` entry to `knip.json` only
with a comment explaining why — never silence a real finding.

### GitHub Actions cost controls

CI runs on the ARC scale set with repo-level self-hosted runners labelled
`self-hosted`, `Linux`, `x64`, `arc`, and `arc-ci`. This is the selected
non-smoke ARC graduation workload for agentsia-uk/Modelsmith#2214 and
agentsia-uk/Modelsmith#2296: typecheck, test, and build are CPU-only and do not
need GPU, Docker privilege, private-network runtime, deploy credentials, or
subscription-auth AI state. Collect three green CI runs before using this
evidence to drain persistent Linux `ci` capacity. Advisory AI review runs on
repo-level self-hosted runners labelled `self-hosted`, `Linux`, and `ai-review`.

CI installs use `pnpm install --frozen-lockfile --prefer-offline` and the
runner-local pnpm store. Avoid remote `actions/setup-node` package caches on
these self-hosted jobs because cache-save uploads can outweigh the work in this
small harness.

AI review runners also need outbound HTTPS access to GitHub, OpenAI, Google, and
Anthropic endpoints. Draft PRs and fork PRs skip advisory AI review while keeping
the workflow contexts present; CI remains the required quality gate.

## Contributing

Issues and pull requests welcome. For substantive changes (new runner, new rubric type, scoring-logic changes) please open an issue first so we can discuss the shape. For typos, documentation, and small fixes please open a PR directly.

## Licensing

Apache 2.0. See `LICENSE`.

## Citation

If you cite Agentsia Labs numbers in your own work, please cite the specific benchmark release (e.g. `Assay-Adtech v1.0`) rather than this repo. The repo is the tool; the benchmark is the claim.

## Related

- [labs.agentsia.uk](https://labs.agentsia.uk) · the Labs surface, methodology, roadmap, and leaderboards
- [agentsia.uk](https://agentsia.uk) · Agentsia, the specialisation control plane for enterprise model fleets
