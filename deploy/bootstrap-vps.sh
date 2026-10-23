#!/usr/bin/env bash
# Installs isolated P0 prerequisites only. Does not open a port or start a service.
set -euo pipefail
umask 077
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
RELAY_PREFIX=/opt/personal-relay
RELAY_ACCOUNT=claude-relay
RELAY_NODE=node-v24.14.0-linux-x64
if ! id "$RELAY_ACCOUNT" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/claude-relay --shell /bin/bash "$RELAY_ACCOUNT"
fi
test "$(getent passwd "$RELAY_ACCOUNT" | cut -d: -f6)" = /var/lib/claude-relay
install -d -m 755 "$RELAY_PREFIX" "$RELAY_PREFIX/runtime"
install -d -m 700 -o "$RELAY_ACCOUNT" -g "$RELAY_ACCOUNT" /var/lib/claude-relay/probe
RELAY_STAGE=$(mktemp -d "$RELAY_PREFIX/runtime/.install-XXXXXX")
trap 'rm -rf "$RELAY_STAGE"' EXIT
if [ ! -x "$RELAY_PREFIX/runtime/$RELAY_NODE/bin/node" ]; then
  curl -fLsS --connect-timeout 15 --max-time 180 \
    "https://nodejs.org/download/release/v24.14.0/$RELAY_NODE.tar.xz" -o "$RELAY_STAGE/node.tar.xz"
  printf '%s  %s\n' 41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df "$RELAY_STAGE/node.tar.xz" | sha256sum --check
  tar -xJf "$RELAY_STAGE/node.tar.xz" -C "$RELAY_PREFIX/runtime"
  chmod -R a+rX "$RELAY_PREFIX/runtime/$RELAY_NODE"
fi
if ! runuser -u "$RELAY_ACCOUNT" -- /var/lib/claude-relay/.local/bin/claude --version 2>/dev/null | grep -q '^2.1.267 '; then
  curl -fLsS --connect-timeout 15 --max-time 60 https://claude.ai/install.sh -o "$RELAY_STAGE/install-claude.sh"
  install -m 600 -o "$RELAY_ACCOUNT" -g "$RELAY_ACCOUNT" "$RELAY_STAGE/install-claude.sh" /var/lib/claude-relay/probe/install-claude.sh
  runuser -l "$RELAY_ACCOUNT" -c 'DISABLE_AUTOUPDATER=1 bash /var/lib/claude-relay/probe/install-claude.sh 2.1.267'
  rm /var/lib/claude-relay/probe/install-claude.sh
fi
"$RELAY_PREFIX/runtime/$RELAY_NODE/bin/node" --version
runuser -u "$RELAY_ACCOUNT" -- /var/lib/claude-relay/.local/bin/claude --version
printf '%s\n' 'P0 prerequisites installed. Subscription login and real model tests are still pending.'
