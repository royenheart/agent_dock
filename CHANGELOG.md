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
