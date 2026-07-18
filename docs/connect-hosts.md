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
prefer not to give the manager direct SSH access. App and agent images are
published together for each V1 release; keep them on the same release when
possible. The current manager and agent release is `1.1.2`.

Use the published image on the target Docker host:

```bash
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/main/agent-compose.image.example.yml
cp agent-compose.image.example.yml agent-compose.yml
openssl rand -base64 48
```

Set a generated token and an explicit manager-reachable bind address, then
start. Both values are required and the examples refuse to render without
them:

```bash
export COMPOSEBASTION_AGENT_VERSION=1.1.2
export AGENT_TOKEN="$(openssl rand -hex 32)"
export COMPOSEBASTION_AGENT_BIND_ADDRESS=192.0.2.10
docker compose -f agent-compose.yml pull
docker compose -f agent-compose.yml up -d
```

Update the agent image with:

```bash
cd ~/composebastion-agent
export COMPOSEBASTION_AGENT_VERSION=1.1.2
export AGENT_TOKEN="$(openssl rand -hex 32)"
export COMPOSEBASTION_AGENT_BIND_ADDRESS=192.0.2.10
docker compose -f agent-compose.image.example.yml pull
docker compose -f agent-compose.image.example.yml up -d
```

If you are building the agent from a source checkout instead, start from
`agent-compose.example.yml`:

```bash
cp agent-compose.example.yml agent-compose.yml
```

Set a strong random `AGENT_TOKEN`, choose the Docker host's trusted LAN address
for `COMPOSEBASTION_AGENT_BIND_ADDRESS`, deploy the agent, and firewall port
`8090` so only the manager can reach it. Never bind the agent directly to a
public interface. Docker-socket access is host-root-equivalent even when Linux
capabilities are dropped.

In ComposeBastion, add the host with connection mode `Host agent`, the agent URL,
and the same token.

### Agent Request Limits

The agent applies separate request budgets per minute, per source IP, and per
endpoint. Configure them in the agent's `.env` file when a large host needs more
capacity:

| Setting | Default | Routes |
|---|---:|---|
| `AGENT_READ_RATE_LIMIT` | 120 | health, host stats, and container usage |
| `AGENT_RUN_RATE_LIMIT` | 30 | Docker commands and container log streams |
| `AGENT_FILE_RATE_LIMIT` | 60 | agent file read, stat, and write |
| `AGENT_STREAM_RATE_LIMIT` | 10 | container usage stream requests |

Values must be positive safe integers. Unset, empty, or whitespace-only values
use the defaults; zero, negative, fractional, non-numeric, and unsafe values
prevent startup. Limits cannot be disabled. The separate cap of four concurrent
container usage streams is unchanged.

Both official agent Compose examples forward these settings. Recreate or
restart the agent after changing them. Raising a limit weakens an availability
safeguard: keep the agent on a trusted LAN, preserve the firewall restriction to
the manager, and raise only the bucket that has measured demand.

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
