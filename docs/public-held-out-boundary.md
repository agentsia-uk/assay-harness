# Public / held-out boundary

This document draws the line between what `assay-harness` can score reproducibly
in the open, and what stays held out. It exists so nobody, an external
reproducer or an internal author, can quietly mix a withheld component into a
published composite and present it as reproducible.

Council reference: `assay-harness-review-2026-06-18` (Tier-2 #7). Epic
[agentsia-uk/assay-harness#54](https://github.com/agentsia-uk/assay-harness/issues/54).

## The single source of truth is the release contract

Per-release counts and identity (governed corpus size, public vs private split,
scenario-set hash, claim gate) live in the **release contract**, not in this
doc and not hard-coded in prose. Read it before quoting any number. The contract
is validated on load by the strict validator in
`tests/cross-repo-contract-validator.ts`, which rejects any unexpected field
(the private-scenario-leak guard). If this doc and the contract ever disagree,
the contract wins and the doc is the bug.

```bash
gh release download <tag> --repo agentsia-uk/assay-harness \
  --pattern 'assay-adtech-*-release-contract.json'
```

The contract carries `scenarioCounts` (`totalInManifest`, `publicExported`,
`privateExcluded`), `provenance.publicPrivateSplit`, `scenarioSetHash`, and
`claimGate`. Those fields, not this prose, are authoritative.

## Released — reproducibly scorable by the public harness

A scenario is **released** when its full scoring inputs ship in the public
harness export, so anyone can regenerate its score from the open repo.

A released scenario provides:

- the prompt input (`input.messages`, or for multi-turn the seed history plus
  the adversarial user turns),
- the scoring rule as data the public scorer can execute — for a programmatic
  rubric the checker id and params, for a persistence criterion the full public
  phrase lists (see below),
- its `benchmarkTier` and outcome-type classification.

Released scenarios are what the golden reproducibility self-test pins: a fixed
corpus plus fixed model outputs must regenerate the same composite in CI. That
self-test is the only thing that actually *proves* a headline number is
reproducible, so a number derived from anything other than released, pinned
inputs is not a reproducible number.

## Held-out — disclosed, never silently mixed

A scenario is **held out** when revealing its full scoring inputs would leak the
benchmark. Held-out scenarios power the leaderboard's integrity; they are
disclosed *as* held out (the contract reports `privateExcluded`), and they are
**never** folded into a published "public" composite without saying so.

Held out, by construction:

- the private holdout scenarios excluded from the public export
  (`scenarioCounts.privateExcluded`),
- the private scenario-generation pipeline (lives in Modelsmith, not here),
- the producer-side gold answer keys — including the per-scenario mechanism
  **alias dictionaries** the producer grader uses to expand a held-out
  scenario's expected phrases. Those dictionaries are the answer key; they do
  not ship in the public port (see the next section).

When a composite spans both released and held-out scenarios, the publication
must label which is which. The `claimGate` is the enforcement point: a contract
with `claimGate.status === "blocked"` is refused for any leaderboard-claim run
by `assertLeaderboardClaimAllowed`.

## Scoring rule vs answer key — where the persistence grader sits

Exposing a *scoring rule* is not the same as exposing an *answer key*. The
public harness ships the executable scoring **mechanism**; the held-out corpus
keeps the **answers**.

The `persistence-grader-v1` port (`src/persistence-grader.ts`) makes this
concrete. It reuses the single-source negation-aware, word-edge matcher in
`src/matchers.ts` (the same one the mechanism scorer uses, governed 48-char
negation window), so "I will **not** approve the refund" is not scored as
approval. What stays private is the per-held-out-
scenario phrase expansion. A **released** multi-turn scenario supplies its own
full phrase lists (`holdPhrases`, `flipPhrases`, `retainedInvariantPhrases`,
...) in the contract, so its persistence score is reproducible from the open
repo. A **held-out** scenario keeps those lists, and the producer's mechanism
alias dictionaries, private.

This is the same boundary `rejectUnexpectedKeys` already enforces structurally:
a public scoring rule may cross the line; a leaked answer-key field must not.

## Judge-mediated components

Some scoring is mediated by an LLM judge rather than a programmatic rule. Those
scores are **not** reproducible in the same hands-off way a programmatic score
is, because they depend on a judge model and its prompt. The harness treats them
accordingly: an `llm-judge` rubric requires an explicit executor, calibration
evidence, prompt provenance, and passing bias checks before it will score, and
its scores default to `analysis-only` so a judged number cannot silently become
a leaderboard claim. A judge-mediated component that contributes to a headline
must be disclosed as judge-mediated, with its judge id, prompt hash, and
calibration recorded.

## Summary table

| Component | Status | Reproducible from the open repo? |
|---|---|---|
| Public scenario export (prompts + programmatic rubric data) | released | yes |
| Multi-turn scenarios with full public persistence phrase lists | released | yes |
| Persistence-grader-v1 matcher (the mechanism) | released | yes |
| Mechanism scorer (anti-bingo cap, negation-aware matching) | released | yes |
| Private holdout scenarios | held out | no (disclosed as excluded) |
| Producer mechanism alias dictionaries / gold answer keys | held out | no |
| Scenario-generation pipeline | held out (in Modelsmith) | no |
| LLM-judge-mediated scores | disclosed, `analysis-only` by default | not hands-off reproducible |

Numbers (corpus size, public count, hash) deliberately omitted here: read them
from the release contract, which is the single source of truth.
