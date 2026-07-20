# GitHub Release Governance

The canonical repository is `composebastion-admin/composebastion`. Pushes,
version changes, tags, image publication, releases, and repository administration
must use exactly the `composebastion-admin` GitHub account with its private
noreply commit address. Public fixtures must use only approved example or test
namespaces.

## `main-release-gate`

Keep an active repository ruleset targeting `main` that:

- requires a pull request with zero approving reviews;
- requires all conversations to be resolved and the branch to be current;
- requires linear history and signed commits;
- requires the nine named CI/release checks documented by the release workflow;
- requires CodeQL with a non-security threshold of `errors` and a security
  threshold of `high_or_higher`;
- blocks force pushes and branch deletion; and
- provides no administrator or repository-role bypass.

The sole-maintainer model intentionally does not require CODEOWNER or second-
reviewer approval. Use squash merging only and automatically delete merged
branches. Activate replacement rules before removing obsolete classic branch
protection so `main` is never left unprotected.

## Release Tags And Releases

Keep an active `release-tags` ruleset for `refs/tags/v*`. Tag creation is allowed
through the authorized release workflow, while tag updates and deletions are
restricted without bypass. Future GitHub Releases must be immutable and carry
release attestations. Existing release tags and legacy registry manifests are
historical records and must not be rewritten or deleted.

For each stable release, run every gate from one clean protected commit, publish
both multi-architecture images, verify anonymous pulls and manifests, and create
the immutable GitHub Release. `v1.1.3` follows the same rescan and promotion
gates as other V1 patch releases.

## Labels And Public Intake

Use the documented type, area, release, priority, and status label families.
Do not advertise unsolicited code contribution through `good first issue`,
`help wanted`, or default contribution-seeking labels. Feature requests and
problem reports remain welcome as maintainer-owned issues, while external code
is closed unmerged and independently reimplemented when accepted.

## Historical Release Integrity

Backfilled releases use the matching changelog section and the existing tag;
they do not replay builds or rewrite commits. The orphan `v0.9.6` registry images
remain documented evidence only: revision
`d790f9b81ecb442af332500546d7b0348926258c`, app index
`sha256:1bdfb93eb509c478b2cc4eddff853de92b0a8cd0e56031ed3500857447a54c2c`,
and agent index
`sha256:a1cb87f0e7cd101aaa41d00cc6ba5d1c06b8cef91dfbbdc048af4b8a266e9661`.
Do not create a missing tag or remove legacy `run-*` manifests that may still be
referenced by indexes.
