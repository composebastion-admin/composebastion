# Dockermender Repository Instructions

## Repository Ownership

- The canonical repository is `https://github.com/Admin-DockerMender/dockermender`.
- Pushes, tags, releases, and version updates must use the `admin-dockermender`
  GitHub account.
- Do not reintroduce references to older personal owners or repositories.

## Adding SSH Docker Hosts

Always treat these as hard requirements for SSH-backed host add/check flows and related documentation:

- The remote host must have Docker Engine installed.
- Docker Compose v2 must work as `docker compose`.
- The configured SSH user must be able to run `docker` and `docker compose` from a non-interactive SSH session.
- The configured SSH user must be able to access the configured Docker socket, usually `/var/run/docker.sock`, without an interactive `sudo` prompt.
- If Docker socket access fails, guide operators to add the SSH user to the host's Docker group, then fully log out and back in or reboot before retrying.
- If operators do not want to grant Docker socket access to an SSH user, guide them to use the Dockermender host agent instead.

Use this preflight command in docs or troubleshooting copy:

```bash
ssh <ssh-user>@<host> 'docker version --format "{{.Server.Version}}" && docker compose version --short && docker ps'
```
