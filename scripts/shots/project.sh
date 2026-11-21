#!/usr/bin/env bash
# Creates the small neutral project the pictures are recorded on.
# Usage: project.sh <dir>   (the directory is replaced)
set -euo pipefail
WS="$1"
rm -rf "$WS"
mkdir -p "$WS/src" "$WS/test"
cat > "$WS/package.json" <<'EOF'
{
  "name": "tinytable",
  "version": "0.1.0",
  "description": "Rows of cells in, an aligned plain-text table out.",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
cat > "$WS/README.md" <<'EOF'
# tinytable

Formats rows of cells as a plain-text table with aligned columns.

```js
import { formatTable } from './src/table.js'

console.log(formatTable([['item', 'qty'], ['bolts', 120], ['nuts', 8]]))
```

Text is aligned to the left. Numbers should be aligned to the right.
EOF
cat > "$WS/src/table.js" <<'EOF'
/** Formats rows of cells as a plain-text table with aligned columns. */
export function formatTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => String(cell).padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
EOF
cat > "$WS/test/table.test.js" <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTable } from '../src/table.js'

test('aligns text to the left', () => {
  const table = formatTable([['name', 'role'], ['Ada', 'engineer'], ['Grace', 'admiral']])
  assert.equal(table, 'name   role\nAda    engineer\nGrace  admiral')
})

test('aligns numbers to the right', () => {
  const table = formatTable([['item', 'qty'], ['bolts', 120], ['nuts', 8]])
  assert.equal(table, 'item   qty\nbolts  120\nnuts     8')
})
EOF
(cd "$WS" && node --test > /dev/null 2>&1 && echo "tests: pass (unexpected)" || echo "tests: one fails, as intended")
ls -R "$WS" | head -n 20
