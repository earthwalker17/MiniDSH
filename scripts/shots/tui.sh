#!/usr/bin/env bash
# Opens a recorded session in the full-screen terminal, out of the snapshot,
# with no key: over a COPY of the log, because a resume appends a lifecycle to
# the log it opens. Usage: tui.sh <session log>
set -euo pipefail
LOG="${1:?usage: tui.sh <session log>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/minidsh-shots
export PATH=/opt/minidsh-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
[ -d "$ROOT/tinytable" ] || bash "$HERE/project.sh" "$ROOT/tinytable" > /dev/null
ID="$(head -n 1 "$LOG" | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).id)')"
rm -rf "$ROOT/store-tui"
mkdir -p "$ROOT/store-tui/sessions"
cp "$LOG" "$ROOT/store-tui/sessions/$ID.jsonl"
export MINIDSH_HOME="$ROOT/store-tui"
cd "$ROOT/tinytable"
exec node /opt/minidsh/bin/minidsh.js resume "$ID"
