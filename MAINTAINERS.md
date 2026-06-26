# Maintainers

`assay-harness` is currently maintained by Agentsia during donation preparation.
It is intended to be handed over to IAB Tech Lab as a complete repository:
source, tests, examples, documentation, release packaging, and GitHub release
tarballs.

## Current Stewardship

- Repository owner before transfer: Agentsia.
- Historical benchmark producer for Assay-Adtech v1: Agentsia / Modelsmith.
- Distribution before transfer: GitHub source and GitHub release tarballs.
- npm publication: not enabled.

## Handover Boundary

IAB Tech Lab receives this repository in full. Agentsia retains ownership of
everything outside this repository, including Modelsmith, private
scenario-generation pipelines, private holdout scenarios, internal training
infrastructure, and customer-specific data or operations.

## Post-Handover Responsibilities

After transfer, IAB Tech Lab should:

- connect the repository to its GitHub organization
- configure GitHub runners and required checks
- publish its security contact and advisory process
- decide whether to publish an npm package or continue with GitHub tarballs
- update package metadata, homepage, topics, and release documentation to point
  at IAB Tech Lab controlled locations
- decide which historical Agentsia / Modelsmith contract checks remain
  normative

## Release Checklist

Before publishing a new release tarball:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm contracts:cross-repo
pnpm typecheck
pnpm audit --prod --audit-level high
pnpm test
pnpm build
pnpm audit:deadcode
pnpm pack
```

Verify the tarball includes built `dist/` files and publish a checksum sidecar
with the release asset.
