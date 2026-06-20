# Development-only "remote Docker host" for end-to-end testing.
#
# Runs sshd with the Docker CLI, Compose plugin, and git, and expects the
# host's /var/run/docker.sock mounted in. ComposeBastion connects to it over
# SSH exactly like a real Linux server. Set COMPOSEBASTION_SSH_AUTHORIZED_KEYS
# to inject one or more public keys at container startup.
#
#   docker build -f infra/dev/sshhost.Dockerfile -t composebastion-dev-sshhost .
#   docker run -d --name composebastion-sshhost \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     --network composebastion_default composebastion-dev-sshhost
#
# Credentials: root / composebastion-test (never use outside local development).
FROM alpine:3.24

RUN apk add --no-cache openssh-server docker-cli docker-cli-compose git bash curl \
  && ssh-keygen -A \
  && echo 'root:composebastion-test' | chpasswd \
  && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
  && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
  && git config --global user.email "dev@composebastion.local" \
  && git config --global user.name "ComposeBastion Dev" \
  && git config --global init.defaultBranch main

ENV COMPOSEBASTION_SSH_AUTHORIZED_KEYS=""

EXPOSE 22
CMD ["/bin/sh", "-c", "if [ -n \"$COMPOSEBASTION_SSH_AUTHORIZED_KEYS\" ]; then mkdir -p /root/.ssh && printf '%s\n' \"$COMPOSEBASTION_SSH_AUTHORIZED_KEYS\" > /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys; fi; exec /usr/sbin/sshd -D -e"]
