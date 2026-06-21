# ComposeBastion Repository Instructions

## Repository Ownership

- The canonical repository is `https://github.com/Admin-ComposeBastion/composebastion`.
- Pushes, tags, releases, and version updates must use the `admin-composebastion`
  GitHub account.
- Do not reintroduce personal owner or repository references.
- Work only in the user-designated checkout. Do not create temporary worktrees,
  alternate clones, or sibling repo folders unless the user explicitly asks.
- Before pushing, tagging, or releasing, check `git remote -v`, the current
  branch, the full `git status`, and the authenticated GitHub account.

## GitHub Conduct

- Never post GitHub comments, request reviews, mark PRs ready, merge PRs, close
  issues, or trigger noisy GitHub Actions unless the user explicitly asks.
- If asked to respond to a GitHub issue, draft short copy-paste text for the
  user instead of posting it automatically.
- Before fixing a GitHub issue, read the issue body, all comments, labels,
  linked issues/PRs, screenshots, images, and logs. Requirements often live in
  follow-up comments or attachments.
- Treat screenshots, images, logs, exported samples, and console traces as
  primary debugging context. Ask for them in issue templates where relevant,
  with clear reminders to redact secrets and customer data.
- Keep issue replies human and practical: thank the reporter, say what changed,
  name the fixed version or branch, and list what to test.
- Close issues only after the fix is merged or released to the intended branch,
  not when it merely exists locally.
- Use the label taxonomy in `.github/labels.md`: one `type:*` label, relevant
  `area:*` labels, priority only after impact is understood, and `status:*`
  labels to show whether the issue is actionable.
- Follow `.github/TRIAGE_GUIDE.md` for issue replies and `.github/RELEASE_PROCESS.md`
  for release work.

## Branches And Releases

- `main` is the current public/stable branch and the branch targeted by push
  CI. Use short-lived feature or `codex/` branches from `main` for normal work.
- If a release ladder is established, keep active work on `dev`, beta/staging
  test releases on `beta`, and promote to `main` only after smoke testing passes.
  Do not create or switch to those branches unless the user or release plan says
  to use them.
- Before committing, run `git status`, inspect the diff, and stage only relevant
  files. Never stage unrelated untracked files, generated `dist` output, local
  test results, `.env`, or duplicate editor/download artifacts.
- Releases must update the root and workspace package versions, `package-lock`,
  relevant tests, `CHANGELOG.md` or release notes, generated OpenAPI docs when
  API contracts change, tags, and target branches according to the release plan.
- Beta or staging changelog entries must include user-facing test notes: what
  changed, what to verify, and any known limits.
- After release pushes, verify GitHub Actions, CodeQL, dependency review,
  container scans, and any configured container/image publishing. Distinguish
  Dependabot or bot PRs opened after the push from actual release failures.

## Quality And Security Gates

- This repo is a Node 20/npm workspaces TypeScript monorepo: Fastify API,
  Postgres, Redis, React/Vite web UI, host agent, Docker Compose deployment, and
  shared Zod contracts.
- Match CI before release work: `npm run typecheck`, `npm run lint:migrations`,
  `npm run openapi:check`, `npm test`, `npm run smoke:web`,
  `npm audit --omit=dev --audit-level=high`, and Docker compose/image smoke
  checks when Docker files change.
- Current GitHub Actions jobs include typecheck/tests/audit, Postgres/Redis
  integration tests, Playwright smoke and accessibility checks, production image
  smoke builds, ephemeral SSH Docker host integration, optional external SSH
  integration, CodeQL, dependency review, and runtime image scanning.
- Treat security scanning separately from feature work. CodeQL, dependency
  scanning, container scanning, secret scanning, and image publishing checks are
  release gates when configured, even if normal tests pass.
- Scanner findings can lag until the target branch is rescanned. Explain that
  security alerts disappear only after the relevant branch scan refreshes.
- Prefer narrow security suppressions with clear comments only for confirmed
  false positives or protocol-required compatibility. Do not broadly hide
  findings.

## Adding SSH Docker Hosts

Always treat these as hard requirements for SSH-backed host add/check flows and related documentation:

- The remote host must have Docker Engine installed.
- Docker Compose v2 must work as `docker compose`.
- The configured SSH user must be able to run `docker` and `docker compose` from a non-interactive SSH session.
- The configured SSH user must be able to access the configured Docker socket, usually `/var/run/docker.sock`, without an interactive `sudo` prompt.
- If Docker socket access fails, guide operators to add the SSH user to the host's Docker group, then fully log out and back in or reboot before retrying.
- If operators do not want to grant Docker socket access to an SSH user, guide them to use the ComposeBastion host agent instead.

Use this preflight command in docs or troubleshooting copy:

```bash
ssh <ssh-user>@<host> 'docker version --format "{{.Server.Version}}" && docker compose version --short && docker ps'
```
