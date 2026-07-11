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
# Password authentication is disabled. Supply an ephemeral authorized key so
# fixture credentials never enter the repository.
FROM alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958

RUN apk add --no-cache openssh-server docker-cli docker-cli-compose git bash curl \
  && ssh-keygen -A \
  && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
  && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && git config --global user.email "dev@composebastion.local" \
  && git config --global user.name "ComposeBastion Dev" \
  && git config --global init.defaultBranch main

ENV COMPOSEBASTION_SSH_AUTHORIZED_KEYS=""

EXPOSE 22
CMD ["/bin/sh", "-c", "if [ -n \"$COMPOSEBASTION_SSH_AUTHORIZED_KEYS\" ]; then mkdir -p /root/.ssh && printf '%s\n' \"$COMPOSEBASTION_SSH_AUTHORIZED_KEYS\" > /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys; fi; printf 'root:%s\n' \"$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64)\" | chpasswd; exec /usr/sbin/sshd -D -e"]
