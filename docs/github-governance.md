# GitHub Release Governance

These controls are intentionally deferred until the release-candidate branches
have been reviewed and the maintainer separately authorizes remote changes.

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

## Deferred Release Work

After explicit approval, push the RC branch and open a draft pull request. Only
close superseded Dependabot pull requests after their replacements are visible
in the pushed branch. Create a retrospective `v1.0.6` GitHub Release marked as
superseded and not latest.

For `v1.0.7`, replace the RC version with the stable version, rerun every gate,
tag only the protected commit, publish both multi-architecture images, verify
anonymous pulls, manifests, and scans, and then create the latest GitHub
Release. Rebase the `v1.1.0` candidate onto that final tag before its pull
request or release work begins.
