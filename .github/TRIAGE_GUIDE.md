# Issue Triage Guide

## First Read

- Read the issue body, every comment, labels, linked issues/PRs, screenshots,
  images, logs, and safe sample data before implementing.
- Treat screenshots, logs, browser console traces, Docker output, and scanner
  findings as primary debugging context.
- Ask for missing logs, screenshots, versions, or environment details only when
  they are actually needed to proceed.

## Labels

- Apply one `type:*` label and at least one relevant `area:*` label.
- Use `status: needs info` when the report is not actionable yet.
- Move to `status: ready` when reproduction, acceptance criteria, or support
  next steps are clear.
- Use `status: blocked` for external dependencies or decisions.
- Use `release: beta` or `release: main` only when the intended release target
  is known.

## Replies

- Keep comments short, human, and practical.
- Thank the reporter, name what changed or what is needed, mention the fixed
  version/branch when known, and say exactly what to test.
- Do not post GitHub comments, request reviews, mark PRs ready, merge PRs, close
  issues, or trigger noisy actions unless the user explicitly asks.
- If an agent is asked for an issue reply, provide copy-paste text unless the
  user explicitly asks the agent to post it.

## Closing

- Close an issue only after the fix is merged or released to the intended branch.
- For beta fixes, leave clear test instructions and the beta version/branch.
- For security scanner findings, note that alerts may remain visible until the
  protected or target branch is rescanned.
