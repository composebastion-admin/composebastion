# Deploy Compose Apps From GitHub

ComposeBastion can track GitHub repositories that contain Docker Compose files,
then deploy or redeploy them to connected hosts.

## Public Repository

1. Open `Deploy` -> `Tracked GitHub repositories`.
2. Enter the repository URL, branch, Compose path, project name, and default
   host.
3. Click `Branches` to confirm the repository is reachable.
4. Save the repository.
5. Use preview/customize deploy to review the Compose YAML before launching the
   job.

## Private Tracked GitHub Repository

Use this path when ComposeBastion should read the Compose file through the
GitHub API, show branches/tags/releases, preview the YAML, and redeploy without
leaving a clone on the Docker host.

Create a fine-grained GitHub token in GitHub:

- Scope it to one repository.
- Grant read-only `Contents` permission.
- Do not grant write permissions.
- If the repository belongs to an organization, approve the token in that
  organization if GitHub requires approval.

In ComposeBastion:

1. Paste the repository URL.
2. Paste the token into the private repository token field.
3. Click `Test Access` to validate repository metadata, the selected ref,
   Compose file contents, tags, and releases.
4. Click `Branches` to load refs.
5. Save the repository.

ComposeBastion encrypts the token with `APP_SECRET`. When editing the repository,
leave the token field blank to keep the saved token, paste a new token to rotate
it, or select `Clear saved GitHub token` to remove it. Config backups include the
encrypted-token payload after backup passphrase encryption, so protect both the
backup passphrase and `APP_SECRET`.

## Private Clone And Deploy Repository

Use this path when the Docker host should keep a real git working tree and
future updates should run host-side `git pull` plus Compose redeploy.

On the Docker host:

1. Generate one SSH key per private repository.
2. Add only the public key to the GitHub repository as a deploy key.
3. Leave write access disabled on the deploy key.
4. If one host needs multiple private repos, configure SSH host aliases so each
   repository can use its own key.

In ComposeBastion:

1. Use the SSH clone URL or host SSH alias URL in `Clone & Deploy any Git
   repository`.
2. Click `Test Host Access`; ComposeBastion runs read-only `git ls-remote` on
   the host to confirm the deploy key works.
3. Clone and deploy after the access check passes.

## Compose Path And Project Name

Use a Compose path relative to the repository root:

```text
docker-compose.yml
deploy/compose.yml
compose.prod.yml
```

Use a lowercase project name that is safe for Docker Compose:

```text
uptime-kuma
media-stack
internal-tools
```

## Redeploy Flow

After a repository is deployed, ComposeBastion records the current commit and can
compare it with the selected branch or tag.

Typical update flow:

1. Open Services.
2. Find the app.
3. Review available GitHub versions or branch state.
4. Open the update preview.
5. Redeploy through the queued job.

## Production Advice

- Pin image tags where possible.
- Keep secrets in `.env` values, not hard-coded Compose YAML.
- Review bind mounts before deploying third-party stacks.
- Create a recovery point before major redeploys.
- Keep GitHub tokens read-only.
