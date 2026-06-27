# Contributing

Thanks for improving `assay-harness`.

This project is an Agentsia-originated benchmark harness prepared for donation
to IAB Tech Lab. During handover, Agentsia-hosted CI and release artifacts remain
in place. After transfer, IAB Tech Lab is expected to connect the repository to
its GitHub organization, runners, maintainers, and release workflow.

## Development Setup

Use Node 22 or later and the pinned pnpm version:

```bash
corepack enable
corepack install
pnpm install
```

Run the standard local checks before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit:deadcode
```

When the sibling Modelsmith repository is available, also run:

```bash
pnpm contracts:cross-repo
```

That check validates the historical Agentsia / Modelsmith producer contract.
It is intentionally retained during handover; IAB Tech Lab may replace it with
its own contract source after transfer.

## Change Policy

Open an issue first for:

- new provider runners
- new rubric kinds or scoring behavior
- release-contract schema changes
- proof-bundle schema changes
- changes that affect benchmark-claim eligibility
- changes to public/held-out data boundaries

Small fixes, documentation improvements, and tests can go straight to a pull
request.

## Pull Request Expectations

Pull requests should include:

- a concise summary of the behavior or documentation changed
- why the change is needed
- validation commands and results
- notes on any public API, CLI, release, or benchmark-claim impact

Keep benchmark data, private holdouts, provider credentials, raw private model
outputs, and Modelsmith-internal state out of this repository.

## Release Packaging

Public distribution is GitHub release tarballs for now. The package is marked
private and is not published to npm. The `prepack` script builds `dist` before
packaging so local release dry-runs match the release tarball shape.

Use:

```bash
pnpm pack
```

and verify the tarball contains `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`,
and documented public assets.
