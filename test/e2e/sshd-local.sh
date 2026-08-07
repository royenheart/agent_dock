#!/bin/sh
# Local SSH server sandbox for e2e tests (NO personal servers involved).
# Usage:
#   test/e2e/sshd-local.sh start [port]
#   test/e2e/sshd-local.sh stop
# Sets AGENTDOCK_E2E_HOST/PORT/USER/KEY and writes AGENTDOCK_E2E_HOME
# (~/.ssh/known_hosts + id_ed25519) so the persistent-SSH path can be tested.
# Everything lives under /tmp/agentdock-sshd and is wiped on start.
set -eu

ROOT=/tmp/agentdock-sshd
PORT="${2:-2222}"
USER=e2e

start() {
  rm -rf "$ROOT"
  mkdir -p "$ROOT/home/.ssh" "$ROOT/etc"
  # host key + client keypair
  ssh-keygen -q -t ed25519 -N '' -f "$ROOT/host_key"
  ssh-keygen -q -t ed25519 -N '' -f "$ROOT/home/.ssh/id_ed25519"
  cp "$ROOT/home/.ssh/id_ed25519.pub" "$ROOT/authorized_keys"
  chmod 600 "$ROOT/home/.ssh/id_ed25519"
  # sshd config (non-root friendly)
  cat > "$ROOT/etc/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $ROOT/host_key
AuthorizedKeysFile $ROOT/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
StrictModes no
PermitRootLogin no
PubkeyAuthentication yes
Subsystem sftp internal-sftp
LogLevel ERROR
PidFile $ROOT/sshd.pid
EOF
  /usr/sbin/sshd -D -e -f "$ROOT/etc/sshd_config" > "$ROOT/sshd.log" 2>&1 &
  echo $! > "$ROOT/sshd.pid"
  # wait for port
  i=0
  while [ $i -lt 30 ]; do
    if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then break; fi
    i=$((i+1)); sleep 0.2
  done
  # record host key into the sandbox known_hosts (persistent-path verification)
  # ssh-keyscan 对非默认端口输出 [127.0.0.1]:PORT 形式；剥成纯主机名以便 known_hosts 校验匹配
  ssh-keyscan -p "$PORT" 127.0.0.1 2>/dev/null | sed -E 's/^\[([0-9.]+)\]:[0-9]+ /\1 /' > "$ROOT/home/.ssh/known_hosts"
  cat > "$ROOT/env" <<EOF
export AGENTDOCK_E2E_HOST=127.0.0.1
export AGENTDOCK_E2E_PORT=$PORT
export AGENTDOCK_E2E_USER=$USER
export AGENTDOCK_E2E_KEY=$ROOT/home/.ssh/id_ed25519
export AGENTDOCK_E2E_HOME=$ROOT/home
EOF
  echo "local sshd on 127.0.0.1:$PORT (root=$ROOT)"
}

stop() {
  if [ -f "$ROOT/sshd.pid" ]; then
    kill "$(cat "$ROOT/sshd.pid")" 2>/dev/null || true
    rm -f "$ROOT/sshd.pid"
  fi
  echo "local sshd stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop [port]"; exit 1 ;;
esac
