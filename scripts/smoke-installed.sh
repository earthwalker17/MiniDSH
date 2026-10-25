#!/usr/bin/env bash
# The installed-package smoke: ONE script for every place this project installs
# its own package — check.yml (the packed checkout, on all three platforms) and
# release.yml (the packed bytes about to ship, then the same version back from
# the public registry). It was three copies, and the release's two had drifted
# to a weaker gate than the branch's: no web client page, no browser row, no
# bundled skills (the S20.5 review). One copy cannot drift from itself.
#
# Usage: bash scripts/smoke-installed.sh <dir> <version>
#   <dir>      a directory in which `minidsh` is installed (node_modules/minidsh)
#   <version>  the exact version the installed binary must report
#
# Keyless: this proves the package installs and STARTS; live.yml is what proves
# it works. Every probe ASSERTS something rather than merely exiting 0, and is
# piped into a reader that may exit early (`grep -q`) under `pipefail`, so a
# binary that crashed on the EPIPE that follows (bin/minidsh.js) fails here.
set -euo pipefail

DIR="$1"
VERSION="$2"
cd "$DIR"
PKG="node_modules/minidsh"
# A home of its own, outside the package: nothing here may read the runner's.
# Relative, as the step it replaced had it: Git Bash on Windows hands a POSIX
# absolute path to node.exe only where it guesses that a value IS a path.
export MINIDSH_HOME=.smoke-home
minidsh() { node "$PKG/bin/minidsh.js" "$@"; }

# The installed bin must pick dist/: src/ is not in the tarball, and Node would
# refuse to strip types under node_modules anyway.
test ! -e "$PKG/src"
test -f "$PKG/dist/app/cli.js"
# The web client: its page, and the module app.js imports at load — missing,
# the installed browser client is a blank page.
test -f "$PKG/dist/app/web/index.html"
test -f "$PKG/dist/app/web/rows.js"

# The exact version: `^minidsh ` would also accept the "minidsh unknown" that
# version.ts prints when the emit cannot find package.json.
minidsh --version | grep -qx "minidsh $VERSION"

# `config` proves the whole plugin graph assembled, and the browser is a
# default row the installed package must carry; the listing proves it answered
# the empty case rather than failing silently into no output.
minidsh config | grep -q 'core-agent-loop'
minidsh config | grep -q 'tool-browser'
minidsh sessions list 2>&1 | grep -q 'no stored sessions'

# The bundled skills are data beside the code (`files` whitelists `skills`),
# and the INSTALLED binary must find them: listed, origin `bundled`, from inside
# the installed package — not from a checkout.
test -f "$PKG/skills/office/SKILL.md"
test -f "$PKG/skills/pdf/scripts/pdf.mjs"
minidsh skills --json > .smoke-skills.json
node - .smoke-skills.json <<'JS'
const path = require('path')
const report = require(path.resolve(process.argv[2]))
const inside = path.join('node_modules', 'minidsh', 'skills')
for (const name of ['office', 'pdf']) {
  const skill = report.listed.find((entry) => entry.name === name)
  if (!skill || skill.origin !== 'bundled' || !path.resolve(skill.path).includes(inside)) {
    console.error(`not listed from the installed package: ${name}\n${JSON.stringify(report, null, 2)}`)
    process.exit(1)
  }
}
console.log(`bundled skills listed: ${report.listed.map((entry) => `${entry.name} (${entry.origin})`).join(', ')}`)
JS

echo "smoke: minidsh $VERSION installed in $DIR starts, assembles, and finds its client and its bundled skills"
