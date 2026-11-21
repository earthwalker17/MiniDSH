#!/usr/bin/env bash
# Records one real session for the pictures, out of the snapshot (snapshot.sh)
# and on the scratch project (project.sh), then scans its log for anything
# that must not be published (scan.mjs). The provider key arrives in the
# environment and is never printed.
#
#   record.sh <copy the log to this directory> [words the log must not hold...]
#
# Run as root under neutral paths for the reason snapshot.sh gives: a model's
# `ls -la` or `which node` writes whatever it sees into a log that is then
# published.
set -euo pipefail
OUT="${1:?usage: record.sh <directory> [forbidden words...]}"
shift
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/minidsh-shots
export PATH=/opt/minidsh-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ -n "${DEEPSEEK_API_KEY:-}" ] || { echo "no DEEPSEEK_API_KEY in the environment" >&2; exit 3; }
mkdir -p "$ROOT"
bash "$HERE/project.sh" "$ROOT/tinytable"
export MINIDSH_HOME="$ROOT/store-record"
rm -rf "$MINIDSH_HOME"
echo "$(node /opt/minidsh/bin/minidsh.js --version), node $(node --version), bwrap $(bwrap --version)"
cd "$ROOT/tinytable"
TASK='The second test in test/table.test.js fails: numbers should be aligned to the right. Fix src/table.js and run the tests.'
set +e
node /opt/minidsh/bin/minidsh.js run "$TASK" --cwd "$ROOT/tinytable" --max-steps 16 > "$ROOT/run.out" 2> "$ROOT/run.err"
CODE=$?
set -e
echo "run exit=$CODE"
tail -n 8 "$ROOT/run.out"
(cd "$ROOT/tinytable" && node --test > /dev/null 2>&1 && echo "world: the tests pass" || echo "world: the tests FAIL")
mkdir -p "$OUT"
cp -f "$MINIDSH_HOME"/sessions/*.jsonl "$OUT"/
for log in "$MINIDSH_HOME"/sessions/*.jsonl; do node "$HERE/scan.mjs" "$log" "$@"; done
