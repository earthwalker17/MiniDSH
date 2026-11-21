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
# This script runs from the checkout (check.yml, release.yml), and the browser
# client's asset list lives beside it: resolved before the cd.
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
# The licence and the attribution notice travel with the code: `files` in
# package.json is the only thing that ships them, and nothing else here would
# notice either one dropping out of the tarball.
test -s "$PKG/LICENSE"
test -s "$PKG/NOTICE"
# The web client: EVERY asset the page loads — one missing, and the installed
# browser client is a blank page. The list is `WEB_ASSETS` in build.ts, the
# one list (src/app/web/assets.test.ts holds it to what the page loads),
# imported rather than copied here so the two cannot drift. Importing build.ts
# builds nothing (`import.meta.main`); it is in the checkout, so Node strips
# its types.
node --input-type=module - "$SCRIPTS/build.ts" "$PKG/dist/app/web" <<'JS'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [buildScript, webDir] = process.argv.slice(2)
const { WEB_ASSETS } = await import(pathToFileURL(resolve(buildScript)).href)
if (!Array.isArray(WEB_ASSETS) || WEB_ASSETS.length === 0) {
  console.error(`no WEB_ASSETS exported by ${buildScript}`)
  process.exit(1)
}
const missing = WEB_ASSETS.filter((asset) => !existsSync(join(webDir, asset)))
if (missing.length > 0) {
  console.error(`the installed browser client lacks: ${missing.join(', ')} (in ${webDir})`)
  process.exit(1)
}
console.log(`browser client assets installed: ${WEB_ASSETS.join(', ')}`)
JS

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

# The terminal from the tarball: its line view on an empty pipe draws the
# banner and exits 0 at once, no model called. This is what loads the
# terminal's imports of the browser's modules from dist/, and drives `--plain`
# itself (S22.1: the flag was promised and never parsed; only this caught it).
mkdir -p .smoke-ws
minidsh chat --plain --cwd .smoke-ws < /dev/null | grep -q "^minidsh $VERSION"
echo "terminal line view starts from the installed package"

echo "smoke: minidsh $VERSION installed in $DIR starts, assembles, finds its client and its bundled skills, and opens its terminal"
