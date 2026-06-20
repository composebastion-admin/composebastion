# Connect Docker Hosts

ComposeBastion can manage hosts through SSH or through the optional host agent.
Use SSH when you already have trusted admin access to the host. Use the agent
when you want Docker-only operations exposed to the manager.

## SSH Mode

The SSH user must be able to run Docker without an interactive `sudo` prompt.

Check the host before adding it:

```bash
ssh <ssh-user>@<host> 'docker version --format "{{.Server.Version}}" && docker compose version --short && docker ps'
```

If Docker socket access fails, add the user to the Docker group on the remote
host:

```bash
sudo usermod -aG docker <ssh-user>
```

Fully log out and back in, or reboot the host, then run the check again.

Recommended SSH host settings:

- Docker socket path: `/var/run/docker.sock`
- Auth: private key for servers, password only where policy allows it.
- Tags: environment or ownership labels such as `prod`, `lab`, `media`, or
  `edge`.

## Agent Mode

The ComposeBastion agent is a small Docker-only command proxy for hosts where you
prefer not to give the manager direct SSH access.

Start from `agent-compose.example.yml`:

```bash
cp agent-compose.example.yml agent-compose.yml
```

Set a long `AGENT_TOKEN`, deploy the agent on the target host, and expose port
`8090` only to the manager network.

In ComposeBastion, add the host with connection mode `Host agent`, the agent URL,
and the same token.

## Security Notes

- Keep SSH users least-privilege, but remember Docker socket access is powerful.
- Do not expose the agent port publicly.
- Keep `ALLOW_PRIVATE_AGENT_URLS=false` unless agents intentionally live on a
  private network reachable by the manager.
- Use owner/admin roles for host terminal access. Routine Docker operations can
  be handled by operators through typed jobs.

## Troubleshooting

If a host stays offline:

1. Run the SSH preflight command from the manager network.
2. Check the Docker socket path.
3. Confirm Docker Compose v2 is installed as `docker compose`.
4. Run a host check from the ComposeBastion UI.
5. Check `docker compose logs -f app worker` on the manager.
