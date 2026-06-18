# Governed scoring constants (Rule-28)

The mechanism scorer (assay-harness#54, council `assay-harness-review-2026-06-18`,
3/3) leans on three numeric constants. Each one is load-bearing for the
anti-bingo claim the public README makes, so each one carries a documented
derivation here AND a unit assertion in `tests/scoring-constants.test.ts` that
fails the build if the value silently drifts. Changing any value means changing
this note and that test in the same commit.

## 1. Anti-bingo hard cap — `0.2`

Defined: `ANTI_BINGO_CAP` in `src/mechanism.ts`.

When an answer's only support is echoed scenario vocabulary (a `bingoToken`)
with no quantitative anchor and no disambiguation, the score is capped at 0.2.

Derivation. The cap must sit strictly below the 0.5 pass threshold (a
pure-vocabulary answer has to FAIL) and strictly above 0.0 (a non-zero floor
keeps a GRPO-style reward signal off a hard cliff, so a model that at least named
the right domain is distinguishable from one that produced garbage). 0.2 is the
midpoint of the `(0, 0.45]` band beneath the lowest single graded gate weight
(quantitative = 0.45), which keeps a bingo echo provably worse than landing even
one genuine gate. Inherited verbatim from the Modelsmith rubric this scorer is
ported from (`src/lib/eval/scenarios/adtech/_mechanism-rubric.ts`).

## 2. Negation window — `48` characters

Defined: `NEGATION_WINDOW_CHARS` in `src/matchers.ts`.

Look-behind window used to decide whether a matched phrase sits inside a negated
clause ("do not flag", "rather than X").

Derivation. A direct negation cue that flips a target phrase's meaning sits
within roughly one short clause of it — under ~8 words empirically. At an English
mean of ~5.1 characters/word plus a space, 8 words is about 48 characters. Wider
windows pull in negations belonging to a *different* clause (false suppression of
a genuinely-stated mechanism); narrower ones miss "do NOT, under any
circumstances, flag" insertions. Clause boundaries (`. ! ? ;`, "but", "however",
"then") reset the window, bounding the blast radius regardless. Inherited from
the Modelsmith matcher (`src/lib/eval/rubric-text-matchers.ts`).

## 3. Frontier quorum — `≥2/3`

Defined: `FRONTIER_QUORUM_*` in `src/mechanism.ts` (documentary constants).

A composite scored by this harness is only publishable as a headline claim when
at least 2 of 3 frontier reference models corroborate the corpus's intended
outcome labels.

Derivation. Three independent frontier graders, simple majority. One grader
gives no cross-check (a single model's idiosyncrasy becomes the ground truth);
all-three (3/3 unanimity) is too brittle and would discard a corpus on a single
grader's outlier. 2/3 is the smallest majority that survives one grader
disagreeing, matching the council's own 3-reviewer 2/3 quorum convention. The
constant is asserted here so the publication gate cannot quietly relax to "any
one grader agrees".
