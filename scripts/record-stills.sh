#!/bin/bash
# [legacy] 分镜静态截图管线。正式 README 演示请用 scripts/record-demo.sh
# （CDP 连续录屏 + HTML 补帧，npm run demo:record）。
# 本脚本保留作单画面调试：启动即进入某一 stage 截一张 PNG。
# 隐私：全部本地 sshd 沙箱 + fixture 示例数据；主机名用 AGENTDOCK_HOSTNAME 覆盖。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO/docs/demo"
mkdir -p "$OUT_DIR"
PORT_A=2222
PORT_B=2223
ROOT_A=/tmp/agentdock-sshd-a
ROOT_B=/tmp/agentdock-sshd-b
E2E_USER=$(whoami)
SHARED_KEY=/tmp/demo-shared-key
STILLS=/tmp/demo-stills
rm -rf "$STILLS" && mkdir -p "$STILLS"

# ---------- 两台 sshd 沙箱（共享 key） ----------
rm -f "$SHARED_KEY" "$SHARED_KEY.pub"
ssh-keygen -q -t ed25519 -N '' -f "$SHARED_KEY"
start_sshd() {
  local ROOT="$1" PORT="$2"
  rm -rf "$ROOT" && mkdir -p "$ROOT/home/.ssh" "$ROOT/etc"
  ssh-keygen -q -t ed25519 -N '' -f "$ROOT/host_key"
  cp "$SHARED_KEY" "$ROOT/home/.ssh/id_ed25519"
  cp "$SHARED_KEY.pub" "$ROOT/home/.ssh/id_ed25519.pub"
  cp "$SHARED_KEY.pub" "$ROOT/authorized_keys"
  chmod 600 "$ROOT/home/.ssh/id_ed25519" "$ROOT/authorized_keys"
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
Subsystem sftp internal-sftp
SetEnv HOME=$ROOT/home
LogLevel ERROR
PidFile $ROOT/sshd.pid
EOF
  /usr/sbin/sshd -D -e -f "$ROOT/etc/sshd_config" > "$ROOT/sshd.log" 2>&1 &
  echo $!
  local i=0
  while [ $i -lt 30 ]; do if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then break; fi; i=$((i+1)); sleep 0.2; done
  ssh-keyscan -p "$PORT" 127.0.0.1 2>/dev/null > "$ROOT/home/.ssh/known_hosts"
  if [ "$ROOT" != "$ROOT_A" ]; then cat "$ROOT/home/.ssh/known_hosts" >> "$ROOT_A/home/.ssh/known_hosts"; fi
}
SSHD_A=$(start_sshd "$ROOT_A" "$PORT_A")
SSHD_B=$(start_sshd "$ROOT_B" "$PORT_B")
trap 'kill $SSHD_A $SSHD_B 2>/dev/null || true' EXIT

# ---------- fixtures ----------
node "$REPO/scripts/demo-fixtures.mjs" "$ROOT_A/home" local /tmp/demo-ws
node "$REPO/scripts/demo-fixtures.mjs" "$ROOT_A/home" a
node "$REPO/scripts/demo-fixtures.mjs" "$ROOT_B/home" b

# ---------- 逐画面截图 ----------
capture() { # $1=stage $2=out.png
  local STAGE="$1" OUT="$2"
  rm -rf /tmp/code-still-ud /tmp/demo-ws && mkdir -p /tmp/code-still-ud /tmp/demo-ws
  xvfb-run -a bash -c "
    export XDG_RUNTIME_DIR=/tmp/xdg-still; mkdir -p \$XDG_RUNTIME_DIR
    export HOME=$ROOT_A/home
    export AGENTDOCK_HOSTNAME='Local workstation'
    export AGENTDOCK_DEMO=1 AGENTDOCK_DEMO_STAGE=$STAGE
    export AGENTDOCK_DEMO_SERVERS='[{\"name\":\"demo-sshd-a\",\"host\":\"127.0.0.1\",\"port\":$PORT_A,\"user\":\"$E2E_USER\",\"dir\":\"/tmp/apps/app-a\"},{\"name\":\"demo-sshd-b\",\"host\":\"127.0.0.1\",\"port\":$PORT_B,\"user\":\"$E2E_USER\",\"dir\":\"/tmp/apps/app-b\"}]'
    rm -f /tmp/demo-done.marker
    /usr/share/code/code --user-data-dir=/tmp/code-still-ud --no-sandbox --disable-gpu \
      --skip-welcome --skip-release-notes --disable-workspace-trust \
      --extensionDevelopmentPath=$REPO --new-window /tmp/demo-ws >/dev/null 2>&1 &
    P=\$!
    sleep 13
    import -window root $STILLS/$OUT 2>/dev/null || true
    kill \$P 2>/dev/null || true
  "
  echo "$STAGE: marker=$(cat /tmp/demo-done.marker 2>/dev/null || echo MISSING) size=$(stat -c%s $STILLS/$OUT 2>/dev/null || echo 0)"
}

capture tree      still-tree.png
capture file-a    still-file-a.png
capture file-b    still-file-b.png
capture transcript still-transcript.png
capture settings  still-settings.png

# 静态画面同步到 docs/demo/（供 review 与复用）
cp "$STILLS"/still-*.png "$OUT_DIR"/

# ---------- 合成多组 GIF（真实截图 + 信息帧 + 文字标注，每组独立循环） ----------
echo "STILLS=$STILLS: $(ls $STILLS 2>&1 | head -8)"
CJK_FONT=/usr/share/fonts/wqy-microhei-fonts/wqy-microhei.ttc

make_labeled() { # $1=stage.png $2=label $3=out-frame
  local SRC="$1" LABEL="$2" OUT="$3"
  magick "$SRC" -resize 640x466! \
    -gravity south -splice 0x46 -background '#1e1e1e' \
    -font "$CJK_FONT" -gravity south -annotate +0+14 "$LABEL" -fill white -pointsize 24 \
    "$OUT"
}
make_info() { # $1=title $2=body $3=out-frame
  local TITLE="$1" BODY="$2" OUT="$3"
  magick -size 640x512 xc:'#1e1e1e' \
    -font "$CJK_FONT" -fill '#d4d4d4' -pointsize 26 -gravity north -annotate +0+50 "$TITLE" \
    -fill '#9cdcfe' -pointsize 19 -gravity northwest -annotate +48+110 "$BODY" \
    "$OUT"
}

# 素材帧：真实截图 + 真实内容（headless 渲染的 settings / transcript 数据画面）
make_labeled "$STILLS/still-tree.png"    "多服务器 Agent Workspace 树"                         "$STILLS/t1.png"
make_labeled "$STILLS/still-file-a.png"  "打开远程服务器 A 的文件 · 编辑 · 保存（SFTP）"       "$STILLS/t2.png"
make_labeled "$STILLS/still-file-b.png"  "打开远程服务器 B 的文件 · 编辑 · 保存"              "$STILLS/t3.png"
# 真实数据画面：settings（MCPs/Skills/...）与 transcript（会话渲染）用 headless Chrome 截图
node "$REPO/scripts/render-demo-html.mjs" "$STILLS/html" "$ROOT_A/home" >/dev/null
for name in settings transcript; do
  google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size=640,466 --screenshot="$STILLS/${name}-raw.png" "file://$STILLS/html/$name.html" >/dev/null 2>&1 || true
done
make_labeled "$STILLS/settings-raw.png"   "Agent 设置：MCPs · Skills · Plugins · Hooks（真实数据）" "$STILLS/t5.png"
make_labeled "$STILLS/transcript-raw.png" "Sessions · Transcript 渲染（含 tool / skill 卡片）"     "$STILLS/t4.png"

mk_gif() { # $1=out.gif $2...=frames（每个重复 $HOLD 次，delay 100 = 1s/帧）
  local OUT="$1"; shift
  local HOLD=3
  local F=""
  for fr in "$@"; do
    for _ in $(seq 1 $HOLD); do F="$F $STILLS/$fr"; done
  done
  # shellcheck disable=SC2086
  magick $F -delay 100 -loop 0 -layers OptimizeFrame -set delay 100 "$OUT"
}

# 1) 多服务器树
mk_gif "$OUT_DIR/demo-multi-server.gif" t1.png
# 2) 远程文件编辑保存（A → B）
mk_gif "$OUT_DIR/demo-remote-edit.gif" t2.png t3.png
# 3) Sessions / Transcript（树画面 + 说明帧）
mk_gif "$OUT_DIR/demo-sessions.gif" t1.png t4.png
# 4) Skills / MCP 设置解析
mk_gif "$OUT_DIR/demo-skills.gif" t5.png

# 合并总览 GIF（5 组各 3 帧）
ALL=""
for t in t1 t2 t3 t4 t5; do
  for _ in 1 2 3; do ALL="$ALL $STILLS/$t.png"; done
done
# shellcheck disable=SC2086
magick $ALL -delay 100 -loop 0 -layers OptimizeFrame -set delay 100 "$OUT_DIR/agent-dock-demo.gif"

ls -la "$OUT_DIR/agent-dock-demo.gif" | awk '{printf "GIF: %s (%.2f MB)\n", $9, $5/1048576}'
echo "STILLS GIF OK → $OUT_DIR/agent-dock-demo.gif"
