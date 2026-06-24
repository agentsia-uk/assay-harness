# Scenario-Set Hash Schema V2

`assay-harness` keeps the original bare `scenarioSetHash` for legacy
compatibility. Schema v2 is additive: new producers can attach
`scenarioSetHashSchemaVersion: "v2"` and `scenarioSetHashMetadata` to a
`RunRecord` or release contract, while older v0 records (no hash) and v1
records (bare hash only) still validate.

## Public Identity

Use `computeScenarioSetHashV2(dataset, options)` when a run or contract needs a
public-safe corpus identity. Callers must provide:

- `domain`: the public benchmark domain id, such as `adtech`.
- `plugin`: the public domain/package/plugin identity that produced the
  scenario shape.
- `implementationFingerprints`: optional public-safe ids or digests for the
  canonicaliser, adapter, or domain pack.
- `scorerFingerprints`: optional public-safe ids or digests for scorer
  implementations.

The returned metadata includes the full hash, a 12-character short hash,
dataset identity, domain and plugin identity, axes, rubric/scoring descriptor
ids, a multi-turn shape summary, public-safe fingerprints, and the field lists
below.

## Hashed Fields

Schema v2 hashes a canonical JSON object with sorted object keys and sorted
scenario ids. The canonical input includes:

- `hashSchemaVersion`
- `dataset.name`
- `dataset.version`
- `domain`
- `plugin`
- `scenario.id`
- `scenario.runnerVisibleInput`
- `scenario.axes`
- `scenario.rubricDescriptor`
- `scenario.scoringDescriptor`
- `scenario.multiTurnShape`
- `implementationFingerprints`
- `scorerFingerprints`

These fields bind the score to the public dataset identity, the domain/plugin
surface that generated the scenario, the runner-visible prompt input, the axes
being claimed, the public scorer/rubric descriptor, the multi-turn execution
shape, and the public-safe implementation/scorer fingerprints.

## Private Answer-Key Exclusions

Schema v2 deliberately excludes private answer-key fields before canonicalising:

- `privateAnswerKey`
- `privateAnswerKeys`
- `heldOutAnswerKey`
- `heldOutAnswerKeys`
- `goldAnswer`
- `goldAnswers`
- `goldLabel`
- `privateScoringData`
- `mechanismAliases`
- `mechanismAliasDictionary`
- `rubric.reference`

Those fields are not runner-visible input. For held-out scenarios they are the
benchmark answer key, not the public corpus identity. A public contract can
still bind to the private scorer without leaking it by publishing an opaque
public-safe scorer fingerprint in `scorerFingerprints`.

If a producer emits an explicit unknown hash schema version, the harness rejects
it. Unknown versions are not treated as legacy because the canonical field set
would be undefined.
