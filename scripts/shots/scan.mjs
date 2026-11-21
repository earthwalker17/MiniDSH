// Summarizes a recorded session log and scans it for what must not be
// published with it: a key, a user name, a host name, a home path.
//
//   node scan.mjs <log> [more words the log must not hold...]
//
// Exits 1 on any hit. The words it always looks for come from this process:
// the provider keys in its environment, its user and its host.
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scan.mjs <log> [words...]')
  process.exit(2)
}
const text = readFileSync(file, 'utf8')
const lines = text
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const header = lines[0]
const events = lines.slice(1)
const count = {}
for (const event of events) count[event.type] = (count[event.type] ?? 0) + 1
console.log(`header: id ${header.id}, cwd ${header.cwd}`)
console.log(
  `events: ${events.length}; ${Object.entries(count)
    .map(([type, n]) => `${type} ${n}`)
    .join(', ')}`,
)

const KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY']
const words = [...KEYS.map((name) => process.env[name]), userInfo().username, hostname(), ...process.argv.slice(3)].filter(
  // `root` is the user these are recorded as, and an `ls -la` prints it.
  (word) => typeof word === 'string' && word.length > 2 && word !== 'root',
)
const patterns = [/sk-[A-Za-z0-9_-]{16,}/, /\/home\/[a-z]/, /\/Users\//, /[A-Za-z]:\\\\Users/, /\/mnt\/[a-z]\//, /[\w.+-]+@[a-z0-9-]+\.(com|org|net)\b/i]
const hits = []
// Never the word itself: one of them may be a key.
words.forEach((word, index) => {
  if (text.includes(word)) hits.push(`holds forbidden word #${index + 1} (${word.length} characters)`)
})
for (const pattern of patterns) {
  const match = pattern.exec(text)
  if (match) hits.push(`matches ${pattern}: …${text.slice(Math.max(0, match.index - 60), match.index + 60).replace(/\n/g, ' ')}…`)
}
if (hits.length > 0) {
  console.log(`scan: ${hits.length} hit(s)\n  ${hits.join('\n  ')}`)
  process.exit(1)
}
console.log('scan: clean')
