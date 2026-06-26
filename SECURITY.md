# Security Policy

## Supported Versions

Security fixes are applied to the current `main` branch and to the latest
GitHub release tarball when a release artifact is affected. Older release
tarballs are immutable; when a fix is needed, maintainers publish a new release
and document the affected versions in the release notes.

## Reporting A Vulnerability

During the handover period, report vulnerabilities through GitHub private
vulnerability reporting if it is enabled on this repository, or by opening a
GitHub security advisory draft with the maintainers. If private reporting is not
available, contact the current repository owner out-of-band and avoid filing a
public issue with exploit details.

After IAB Tech Lab connects this project to its GitHub organization and security
process, use the IAB Tech Lab security contact and advisory process published
for the transferred repository.

## Sensitive Data Boundary

This repository must not contain private holdout scenarios, customer data,
provider API keys, raw private model outputs, internal Modelsmith state, or
other non-public operational material. Public fixtures should remain synthetic
or explicitly release-approved.

When reporting a vulnerability, include:

- affected version, commit, or release tarball
- reproduction steps
- expected and actual behavior
- whether private prompts, raw outputs, credentials, or held-out data could be
  exposed
- suggested remediation if known

## Dependency Advisories

Maintainers should run:

```bash
pnpm audit --prod --audit-level high
```

Moderate advisories should be reviewed before each handoff or release. High and
critical production advisories should block release until fixed or explicitly
documented with a mitigation.
