#!/usr/bin/env bash
# Runs the web host the pictures are taken from, out of the snapshot
# (snapshot.sh), on a fixed loopback port. It prints its one-time link and runs
# until it is killed.
#
#   serve.sh recorded <session log>   no key, no model call: a fresh home holding
#                                     that one recorded session (docs/images/logs)
#   serve.sh live                     a fresh copy of the scratch project and a
#                                     real key from the environment (never
#                                     printed), for a picture that must be taken
#                                     live: an approval waiting to be answered
set -euo pipefail
MODE="${1:-recorded}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/minidsh-shots
export PATH=/opt/minidsh-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p "$ROOT"
if [ "$MODE" = live ]; then
  [ -n "${DEEPSEEK_API_KEY:-}" ] || { echo "no DEEPSEEK_API_KEY in the environment" >&2; exit 3; }
  rm -rf "$ROOT/live" "$ROOT/store-live" "$ROOT/reports"
  mkdir -p "$ROOT/live" "$ROOT/reports"
  bash "$HERE/project.sh" "$ROOT/live/tinytable" > /dev/null
  export MINIDSH_HOME="$ROOT/store-live"
  cd "$ROOT/live/tinytable"
  exec node /opt/minidsh/bin/minidsh.js web --cwd "$ROOT/live/tinytable" --port 20556
fi
LOG="${2:?usage: serve.sh recorded <session log>}"
unset DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
# The session's own folder, as its header names it: a stored session is shown
# without it, but the host needs a folder to start in.
[ -d "$ROOT/tinytable" ] || bash "$HERE/project.sh" "$ROOT/tinytable" > /dev/null
ID="$(head -n 1 "$LOG" | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).id)')"
rm -rf "$ROOT/store"
mkdir -p "$ROOT/store/sessions"
cp "$LOG" "$ROOT/store/sessions/$ID.jsonl"
export MINIDSH_HOME="$ROOT/store"
cd "$ROOT/tinytable"
exec node /opt/minidsh/bin/minidsh.js web --cwd "$ROOT/tinytable" --port 20555
