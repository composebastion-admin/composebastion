# GitHub Release Governance

These controls are intentionally deferred until the release-candidate branches
have been reviewed and the maintainer separately authorizes remote changes.
The current CODEOWNERS file names the canonical `@composebastion-admin` account,
but a pull-request author cannot approve their own CODEOWNER review. Do not
activate the rule until a distinct trusted reviewer or team has been added to
CODEOWNERS and a test pull request proves the review path works.

## Required `main-release-gate` Rule

Apply a repository rule to `main` that:

- requires one approving review and CODEOWNERS review;
- dismisses stale reviews and requires every conversation to be resolved;
- requires branches to be current before merge;
- applies to administrators;
- blocks force pushes and branch deletion; and
- requires CI quality, Postgres integration, browser smoke, production image,
  SSH integration, CodeQL, dependency review, container-scan aggregate, and
  release-image aggregate checks.

Do not create or alter this rule from a local candidate implementation.

## Release Work

For each stable release, rerun every gate, tag only the protected commit,
publish both multi-architecture images, verify anonymous pulls, manifests, and
scans, and then create the latest GitHub Release. Patch releases such as
`v1.1.2` must follow the same image rescan and aggregate promotion gates as
minor releases.
