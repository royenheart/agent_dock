## v0.2.1 (2026-08-08)

### Feat

- esbuild bundling + unified package entry (7.8MB → 1.97MB vsix)

### Fix

- **ci**: stop using vsce package --no-dependencies — bundle runtime deps

## v0.2.0 (2026-08-08)

### Feat

- unlock other-server files for editing (SFTP write path)
- persistent SSH + SFTP transport (ssh2), local-sshd e2e sandbox
- update terminal and workspace sync

### Fix

- pre-check node-pty binaries before require, harden terminal restore
- host key verification for non-default-port servers ([host]:port)

## v0.1.10 (2026-08-03)

## v0.1.9 (2026-08-03)

### Feat

- tree/persistence robustness and right-click remote refresh
- live refresh & robust polling for remote server files

### Fix

- ssh exec robustness — EPIPE, output cap, cancellation, semaphore

## v0.1.8 (2026-07-28)

### Feat

- add client terminal

## v0.1.7 (2026-07-28)

### Fix

- port forwarding on selected server & settings sync across servers

## v0.1.6 (2026-07-26)

### Feat

- add port forwards

## v0.1.5 (2026-07-26)

### Fix

- settings server sync

## v0.1.4 (2026-07-22)

### Feat

- configurable ssh persist, stale-while-revalidate, README refresh
- targeted refresh, persisted snapshots, longer-lived ssh connections

## v0.1.3 (2026-07-21)

### Feat

- output-channel logging + non-blocking remote ops with skip/timeout

## v0.1.2 (2026-07-21)

### Feat

- remote read-only file preview (plan A)

## v0.1.11 (2026-08-08)

### Fix

- remote fs entries get the full operation set again: new file/folder, rename, delete (with confirm), copy, paste, copy path, open ssh terminal — right-clicking remote files/dirs no longer shows only "refresh file"
- local workspace files/dirs get copy & paste (vscode.workspace.fs), remote ones via ssh cp, with overwrite confirmation
- pinned remote folders (`folder.remote`) and local workspace folders (`folder.workspace`) now have a "refresh directory" action
- remote-dir auto-refresh polling paused when the tree view is hidden and stopped for collapsed dirs (onDidCollapseElement); routine poll ssh calls are quiet (no debug-log spam per poll)
- client terminals (shell / ssh) are persisted across VSCode restart / window reload and re-created on activation; closing a terminal removes it from the saved set
- client terminal Ctrl+C works again: the pipe fallback (no node-pty) now forwards `\x03` to pty-wrapped children (script/ssh -tt) and sends SIGINT to plain-pipe shells instead of silently swallowing it; the packaged vsix bundles node-pty prebuilds again so the real-pty path (native Ctrl+C) is used whenever node-pty is available
- `onStartupFinished` activation: client terminals are restored right after a window reload, without needing to open the Agent Workspace view first
- active port forwards are persisted to workspaceState and automatically restarted after a window reload (per-server; unreachable servers are skipped and retried on next reload)
- tree expansion state survives window reload: every node gets a stable `TreeItem.id` (nodeId), the provider implements `getParent` (nodeParent), and `ExpansionState` records expanded nodes (onDidExpand/onDidCollapse) and replays them via `treeView.reveal(node, {expand:true})` after reload/refresh — VSCode does not persist extension tree-view expansion on its own, so this is now self-managed
- fixed current-server expansion restore: the current server's tree node now always uses `CURRENT_SERVER_KEY` so its id matches what `getParent` derives for folders under it (previously the configured server name was used, breaking reveal for the current server's folders)
- removed the redundant `agentDock.workspaceExplorer` view from the native Explorer container (kept only the Agent Dock Workspace view — the two were duplicates with unsynchronized state)
- client terminals keep a user-renamed title across reload: `syncTrackedTerminalName` (on `onDidChangeTerminalState`) writes the current terminal name back to the persisted descriptor; "Open Terminal Here" now passes an explicit `name` so the native persistent-session title is stable
- client terminals opened from the terminal panel profile dropdown are now persisted too (`onDidOpenTerminal` + pty marker), not only command-opened ones
- terminal/tree restore now logs at debug: `initClientTerminalPersistence` (saved names, skips, restores), `tracked/untracked/sync name`, `persistTerminals` (counts) — set `agentDock.logLevel=debug` to trace why a terminal or expansion is not restored
- expansion restore hardened: fsEntry ids are `encodeURIComponent`-encoded (URIs with `:`/`%2B` no longer break `nodeFromId` parsing), and restore retries shallow-first with a pending queue until the lazy tree data is ready (folders under servers that are still scanning no longer fail permanently)
- vsix slimmed: only node-pty is a runtime `dependency` — dompurify/marked moved to devDependencies (webview uses media/vendor UMD), cutting ~20 MB of unused node_modules from the package

## v0.1.10 (2026-08-03)

### Fix

- ssh exec robustness: EPIPE error listeners (remoteExec + client terminal), stdout byte cap (16 MiB, truncated marker), queued-acquire cancellation via AbortSignal, SIGTERM-before-SIGKILL to protect the shared ControlMaster connection, runSsh under the global concurrency limit
- poll parsing: paths containing `|`, entries named `S|x`/`D|x`/`E|x`/`M|x`, and deleted dirs → null snapshot (right-to-left field split + explicit E|/M| block markers)
- parseLsAp aligned with `ls -1Ap`: names ending in `* @ = | %` kept intact
- readFile: single-call bounded read (no TOCTOU, TOOBIG marker, bounded memory)
- expanded-dir polling: LRU cap (1000) instead of silent 30-minute stop; per-server concurrent polling
- session tree built recursively: nesting depth ≥ 2 no longer lost
- refreshPorts falls back to full re-render instead of a silent no-op
- memento persistence serialized, skipped when unchanged, per-dir node cap, failures logged
- file decorations: no session scan when cache empty; realpath cache kept across refreshes
- servers config read-modify-write serialized; removeServer stops active forwards first
- log level default `info` + invalid-value fallback

## v0.1.9 (2026-08-03)

### Feat

- live auto-refresh for files/directories of other servers (polling watcher: open editors update in place, expanded remote directories re-list on change)
- right-click refresh for remote files ("refresh file content", forces the open editor to re-read) and remote directories
- configurable polling: `agentDock.remoteAutoRefresh` / `agentDock.remoteWatchIntervalSeconds`

## v0.1.8 (2026-07-28)

### Feat

- add client terminal

## v0.1.7 (2026-07-28)

### Fix

- port forwarding on selected server & settings sync across servers

## v0.1.6 (2026-07-26)

### Feat

- add port forwards

## v0.1.5 (2026-07-26)

### Fix

- settings server sync

## v0.1.4 (2026-07-22)

### Feat

- configurable ssh persist, stale-while-revalidate, README refresh
- targeted refresh, persisted snapshots, longer-lived ssh connections

## v0.1.3 (2026-07-21)

### Feat

- output-channel logging + non-blocking remote ops with skip/timeout

## v0.1.2 (2026-07-21)

### Feat

- remote read-only file preview (plan A)

## v0.1.1 (2026-07-21)

### Fix

- repository URL to royenheart/agent_dock (underscore) so vsce-rewritten image URLs resolve
- add icon field so the extension icon shows in the Extensions view

## v0.1.0 (2026-07-20)

### Feat

- rename to Agent Dock (vscoder name taken on marketplace)

## v0.0.1 (2026-07-20)

### Feat

- rename to VSCoder, new logo + promo banner, README rewrite
- session monitor panel with skill breakdown, create-session on folders
- skill usage/token display, remove-from-workspace (plan A), home-dir connect
- model/subagent awareness in transcripts, parent-session nesting, builtin fs commands
- project-level settings coverage, transcript usage/model display, file context menus
- settings sections collapse/filter, real server display names
- path-browsing dir picker, selection-aware add-directory, pinned-only remote folders
- add-directory flow (3-level picker) + transcript refresh button
- structured transcript rendering, two-level add-server, full i18n
- workspace mirror + side-by-side sessions, e2e test infrastructure
- explorer integration, ssh-config server picker, per-agent settings view
- tree view, session transcript panel, settings view, commands
- core session discovery + parsing for opencode/codex/claude

### Fix

- png logo for marketplace readme (vsce rejects svg)
- drop client-side extension presence check that always failed in remote windows
- quickpick built-in filter hid subdir items while typing paths
- let resourceUri drive file icons so theme icons + git/problem decorations render
- sessions under 'sessions' subnode on current server, robust cwd matching, explorer badges
