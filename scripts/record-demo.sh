#!/bin/bash
# 连续录屏生成 README 演示 GIF（e2e 同款本地沙箱：双 sshd + fixture 假数据 +
# 独立 HOME + Xvfb；画面经 VS Code 自身 CDP screencast 抓取，无需 ffmpeg/WM）。
#
# 隐私设计（违反即等同事故）：
#   - 两台"服务器"都是 127.0.0.1 上的本地 sshd 沙箱，数据全部是 fixture 示例
#   - 服务器配置走 ~/.ssh/config 别名（demo-sshd-a/b）——画面上不出现真实用户名/IP/端口
#   - AGENTDOCK_HOSTNAME 覆盖当前服务器显示名；沙箱 .bashrc 固定 PS1=demo@workstation
#   - VS Code 用独立 HOME / user-data-dir，全部落在 /tmp，录完即弃
#
# 用法：scripts/record-demo.sh
# 产物：docs/demo/*.gif（中间帧在 /tmp/agentdock-demo/frames，可用 KEEP_FRAMES=1 保留）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO/docs/demo"
WORK=/tmp/agentdock-demo
HOME_LOCAL="$WORK/home"
WS="$HOME_LOCAL/nebula"
UD="$WORK/user-data"
ROOT_A=/tmp/agentdock-sshd-a
ROOT_B=/tmp/agentdock-sshd-b
PORT_A=2222
PORT_B=2223
CDP_PORT=9223
DISP=:98
REAL_USER=$(whoami)   # 仅用于 ssh 登录沙箱；画面只显示别名，不会暴露它
SHARED_KEY="$WORK/id_ed25519"

mkdir -p "$OUT_DIR"
rm -rf "$WORK" "$ROOT_A" "$ROOT_B"
mkdir -p "$WORK" "$HOME_LOCAL" "$WS"
rm -f /tmp/demo-step-*.marker /tmp/demo-done.marker

# ---------- 沙箱 stub CLI（resume 场景：假装 agent CLI 恢复了会话）----------
write_stubs() { # $1=home
  local B="$1/bin"
  mkdir -p "$B"
  for cli in codex opencode claude; do
    cat > "$B/$cli" <<'EOF'
#!/bin/sh
# 录屏沙箱 stub：打印一个以假乱真的恢复横幅，停留数秒供录屏，不执行任何真实逻辑
agent="$(basename "$0")"
sleep 0.4
printf '\n\033[1m%s\033[0m v0.31.0 (demo sandbox)\n' "$agent"
printf '────────────────────────────────────\n'
printf '  session resumed: %s %s\n' "$1" "$2"
printf '  cwd: %s\n\n' "$PWD"
printf '> Ready. Type your follow-up, or /quit to exit.\n\n'
# 停留让横幅进入 GIF；然后干净退出（ssh 会话随之结束）
sleep 8
EOF
    chmod +x "$B/$cli"
  done
}

# ---------- 两台 sshd 沙箱（共享 key；SetEnv 注入 HOME 与 stub PATH）----------
start_sshd() { # $1=root $2=port
  local ROOT="$1" PORT="$2"
  mkdir -p "$ROOT/home/.ssh" "$ROOT/etc"
  ssh-keygen -q -t ed25519 -N '' -f "$ROOT/host_key"
  write_stubs "$ROOT/home"
  # PermitUserEnvironment + authorized_keys environment=：强制 HOME/PATH
  # （sshd SetEnv 对 PATH 在本机 OpenSSH 上会被默认 PATH 覆盖，不可靠）
  {
    printf 'environment="HOME=%s",environment="PATH=%s/bin:/usr/local/bin:/usr/bin:/bin" ' "$ROOT/home" "$ROOT/home"
    cat "$SHARED_KEY.pub"
  } > "$ROOT/authorized_keys"
  chmod 600 "$ROOT/authorized_keys"
  cat > "$ROOT/etc/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $ROOT/host_key
AuthorizedKeysFile $ROOT/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitRootLogin no
PubkeyAuthentication yes
PermitUserEnvironment yes
Subsystem sftp internal-sftp
SetEnv HOME=$ROOT/home
LogLevel ERROR
PidFile $ROOT/sshd.pid
EOF
  /usr/sbin/sshd -D -e -f "$ROOT/etc/sshd_config" > "$ROOT/sshd.log" 2>&1 &
  echo $! > "$ROOT/sshd.pid"
  local i=0
  while [ $i -lt 30 ]; do if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then break; fi; i=$((i+1)); sleep 0.2; done
}

ssh-keygen -q -t ed25519 -N '' -f "$SHARED_KEY"
start_sshd "$ROOT_A" "$PORT_A"
start_sshd "$ROOT_B" "$PORT_B"

# ---------- 本地沙箱 HOME：ssh 别名 / known_hosts / 固定 PS1 ----------
# 注意：OpenSSH 客户端读 ~/.ssh/config 走 passwd home，不认 $HOME——
# 因此 IdentityFile/UserKnownHostsFile 用绝对路径，并在 $HOME_LOCAL/bin 放
# ssh wrapper（强制 -F 沙箱 config），启动 VS Code 时把该 bin 前置到 PATH。
mkdir -p "$HOME_LOCAL/.ssh" "$HOME_LOCAL/bin"
cp "$SHARED_KEY" "$HOME_LOCAL/.ssh/id_ed25519"
cp "$SHARED_KEY.pub" "$HOME_LOCAL/.ssh/id_ed25519.pub"
chmod 700 "$HOME_LOCAL/.ssh" && chmod 600 "$HOME_LOCAL/.ssh/id_ed25519"
ssh-keyscan -p "$PORT_A" 127.0.0.1 2>/dev/null > "$HOME_LOCAL/.ssh/known_hosts"
ssh-keyscan -p "$PORT_B" 127.0.0.1 2>/dev/null >> "$HOME_LOCAL/.ssh/known_hosts"
cat > "$HOME_LOCAL/.ssh/config" <<EOF
Host demo-sshd-a
  HostName 127.0.0.1
  Port $PORT_A
  User $REAL_USER
  IdentityFile $HOME_LOCAL/.ssh/id_ed25519
  UserKnownHostsFile $HOME_LOCAL/.ssh/known_hosts
  IdentitiesOnly yes
  StrictHostKeyChecking yes
Host demo-sshd-b
  HostName 127.0.0.1
  Port $PORT_B
  User $REAL_USER
  IdentityFile $HOME_LOCAL/.ssh/id_ed25519
  UserKnownHostsFile $HOME_LOCAL/.ssh/known_hosts
  IdentitiesOnly yes
  StrictHostKeyChecking yes
EOF
chmod 600 "$HOME_LOCAL/.ssh/config"
cat > "$HOME_LOCAL/bin/ssh" <<EOF
#!/bin/sh
# 沙箱 wrapper：OpenSSH 忽略 \$HOME，强制使用沙箱 ssh_config（别名可见、真实凭据隐藏）
exec /usr/bin/ssh -F '$HOME_LOCAL/.ssh/config' "\$@"
EOF
chmod +x "$HOME_LOCAL/bin/ssh"
printf "PS1='demo@workstation:\\w\\$ '\nunset PROMPT_COMMAND\n" > "$HOME_LOCAL/.bashrc"
# 远程沙箱 home 也写一份 .bashrc，保证交互式 ssh 登录后 stub CLI 仍在 PATH
for R in "$ROOT_A/home" "$ROOT_B/home"; do
  printf "export PATH=\"%s/bin:\$PATH\"\nPS1='demo@server:\\w\\$ '\n" "$R" > "$R/.bashrc"
done

# ---------- fixtures 假数据 ----------
node "$REPO/scripts/demo-fixtures.mjs" "$HOME_LOCAL" local "$WS"
node "$REPO/scripts/demo-fixtures.mjs" "$ROOT_A/home" a
node "$REPO/scripts/demo-fixtures.mjs" "$ROOT_B/home" b

# ---------- 隔离的 VS Code 用户配置（关更新/遥测/欢迎页）----------
mkdir -p "$UD/User"
cat > "$UD/User/settings.json" <<'EOF'
{
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "terminal.integrated.fontSize": 13
}
EOF

# ---------- 编译（dist/extension.js 是运行时入口）----------
npm run build --prefix "$REPO" >/dev/null

# ---------- Xvfb + VS Code（CDP 调试端口）----------
Xvfb "$DISP" -screen 0 1440x900x24 >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
mkdir -p "$WORK/xdg" && chmod 700 "$WORK/xdg"

DISPLAY="$DISP" XDG_RUNTIME_DIR="$WORK/xdg" HOME="$HOME_LOCAL" \
PATH="$HOME_LOCAL/bin:$PATH" \
AGENTDOCK_HOSTNAME='Local workstation' AGENTDOCK_DEMO=1 AGENTDOCK_DEMO_STAGE=full \
AGENTDOCK_DEMO_SERVERS='[{"name":"demo-sshd-a","host":"demo-sshd-a","dir":"/tmp/apps/app-a"},{"name":"demo-sshd-b","host":"demo-sshd-b","dir":"/tmp/apps/app-b"}]' \
  /usr/share/code/code --user-data-dir="$UD" --no-sandbox --disable-gpu \
    --skip-welcome --skip-release-notes --disable-workspace-trust \
    --remote-debugging-port="$CDP_PORT" \
    --extensionDevelopmentPath="$REPO" --new-window "$WS" >"$WORK/code.log" 2>&1 &
CODE_PID=$!

cleanup() {
  kill "$CODE_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  [ -f "$ROOT_A/sshd.pid" ] && kill "$(cat "$ROOT_A/sshd.pid")" 2>/dev/null || true
  [ -f "$ROOT_B/sshd.pid" ] && kill "$(cat "$ROOT_B/sshd.pid")" 2>/dev/null || true
  rm -f /tmp/demo-step-*.marker /tmp/demo-done.marker
}
trap cleanup EXIT

# ---------- 录制（阻塞到 done marker 或超时）----------
set +e
CDP_PORT="$CDP_PORT" OUT_DIR="$WORK/frames" node "$REPO/scripts/demo-record.mjs"
REC_RC=$?
set -e
kill "$CODE_PID" 2>/dev/null || true
if [ "$REC_RC" = "1" ]; then
  echo "FATAL: recorder could not connect to VS Code CDP; see $WORK/code.log" >&2
  exit 1
fi
[ "$REC_RC" = "3" ] && echo "WARN: demo-done marker not seen — 用已抓帧尽力合成" >&2

# ---------- 合成 GIF（含 headless Chrome 补帧：transcript / settings）----------
# Xvfb 下 SessionPanel webview 常不绘制；用真实数据 HTML + Chrome 截图补上
npm run compile --prefix "$REPO" >/dev/null
HTML_DIR="$WORK/html"
mkdir -p "$HTML_DIR"
# transcript 用服务器 A 的 home（富会话）；settings 用本地 home
HOME="$ROOT_A/home" node "$REPO/scripts/render-demo-html.mjs" "$HTML_DIR/from-a" "$ROOT_A/home" >/dev/null
HOME="$HOME_LOCAL" node "$REPO/scripts/render-demo-html.mjs" "$HTML_DIR/from-local" "$HOME_LOCAL" "$WS" >/dev/null
cp "$HTML_DIR/from-a/transcript.html" "$HTML_DIR/transcript.html"
cp "$HTML_DIR/from-local/settings.html" "$HTML_DIR/settings.html"
for name in transcript settings; do
  google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size=960,640 --screenshot="$WORK/frames/${name}-html.png" \
    "file://$HTML_DIR/$name.html" >/dev/null 2>&1 || true
done
node "$REPO/scripts/demo-gif.mjs" "$WORK/frames" "$OUT_DIR"
[ "${KEEP_FRAMES:-0}" = "1" ] || rm -rf "$WORK/frames"
echo "OK → $OUT_DIR"
ls -la "$OUT_DIR"/*.gif | awk '{printf "  %s (%.2f MB)\n", $9, $5/1048576}'
