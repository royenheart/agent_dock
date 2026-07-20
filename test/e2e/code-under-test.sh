#!/bin/sh
# Bypass the /usr/bin/code wrapper (cli.js detaches the GUI and exits early,
# which kills tests) and the Remote-SSH remote-cli forwarding in this env.
exec env -u VSCODE_IPC_HOOK_CLI /usr/share/code/code "$@"
