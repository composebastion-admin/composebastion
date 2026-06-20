# Deploy Compose Apps From GitHub

Dockermender can track GitHub repositories that contain Docker Compose files,
then deploy or redeploy them to connected hosts.

## Public Repository

1. Open `Deploy` -> `Tracked GitHub repositories`.
2. Enter the repository URL, branch, Compose path, project name, and default
   host.
3. Click `Branches` to confirm the repository is reachable.
4. Save the repository.
5. Use preview/customize deploy to review the Compose YAML before launching the
   job.

## Private Repository

Create a fine-grained GitHub token:

- Scope it to one repository.
- Grant read-only `Contents` permission.
- Do not grant write permissions.

In Dockermender:

1. Paste the repository URL.
2. Paste the token into the private repository token field.
3. Click `Branches`.
4. Save the repository.

Dockermender encrypts the token with `APP_SECRET`. When editing the repository,
leave the token field blank to keep the saved token.

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

After a repository is deployed, Dockermender records the current commit and can
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
