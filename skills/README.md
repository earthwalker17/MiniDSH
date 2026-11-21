# Skills

A skill is a directory holding a `SKILL.md` in the open [Agent Skills](https://agentskills.io) format: YAML front-matter with a `name` and a `description`, then Markdown instructions, sometimes with scripts or reference files beside it. This directory holds the two MiniDSH ships: `office` (.docx, .xlsx, .pptx) and `pdf`.

MiniDSH treats a skill as data, never as code or authority:

- With each prompt it scans the skill roots. The model is shown each skill's name, description and absolute path as optional context, and again only when the list changes.
- The model reads a `SKILL.md` with its ordinary file tools. There is no skill tool and no `/name` command.
- A skill's scripts run as ordinary shell commands, under the session's sandbox and approvals. A skill cannot register tools, hooks, models or permissions.

## Where skills come from

Skills are looked up one level deep, as `<root>/<name>/SKILL.md`:

| origin | where | notes |
|---|---|---|
| `user` | `$MINIDSH_HOME/skills` (default `~/.minidsh/skills`) | wins every name |
| `bundled` | this `skills/` directory, inside the installed package | a user skill of the same name replaces it |
| `workspace` | `.agents/skills` and `.claude/skills` in each directory from the session's cwd up to the project root (the one holding `.git`) | the nearest wins among these |

A repository's skill never replaces a user or bundled one: a workspace skill whose name is taken is not listed, and the operator is warned. Other tools' homes, such as `~/.claude/skills`, are read when the `skills` row's `roots` config names them, or as workspace roots when your home folder is itself the git checkout a session under it climbs to. That config then lists every user and bundled root, as absolute paths.

`minidsh skills` prints what a new session in the current directory would be offered, what was skipped and why, and the roots. It takes `--json`, `--cwd <dir>` and `--patch <file>`.

## Adding, replacing, disabling, removing

- **Add or replace:** create `~/.minidsh/skills/<name>/SKILL.md`. It is listed from the next prompt, in place of a bundled skill of the same name.
- **Hide** some: `{"patches": [{"id": "skills", "config": {"maxBytes": 8000, "exclude": ["pdf"]}}]}` in `~/.minidsh/composition.json` or a `--patch` file. A patch replaces the row's whole config, so restate `maxBytes`.
- **Turn skills off:** `{"patches": [{"id": "skills", "disabled": true}]}`. A resumed session keeps the list it already has. A row kept with `"roots": []` and `"workspaceDirs": []` beside `maxBytes` retires that list too.
- **Keep one of yours unlisted:** set `disable-model-invocation: true` in its front-matter.
- **Remove:** delete its directory.

## Writing a skill

- `name` is lowercase letters, digits and single hyphens, at most 64 characters. Make it the directory name. `description` says what the skill does and when to use it. The list shows at most 500 characters of it.
- Keep `SKILL.md` small and route to reference files. Keep every Markdown file within 8,192 characters as a file reader shows it, with line numbers.
- Write only what a capable model would not know, as optional know-how.
- Show each script call with a quoted absolute path. A script takes `--help`, bounds its output, exits non-zero with the error on stderr, never prompts, and writes only the output path it is given.

## The bundled skills and their tests

Each is a `SKILL.md` and a Node helper with no dependencies: `office/scripts/office.mjs` (`probe`, `build`, `read`, `unpack`, `pack`) and `pdf/scripts/pdf.mjs` (`probe`, `info`, `read`, `build`). `office` adds a reference file per format. They check a document's content, never its appearance: nothing renders the result.

`src/app/bundled-skills.test.ts` runs under `pnpm check`. It holds each `SKILL.md` to the rules above and to naming only files that exist. It runs the helpers as a model would and reopens what they write: with the helper's `read`, with a ZIP and XML reader of its own, and with Python's `zipfile`. Without Python that last check is skipped, unless `MINIDSH_EXPECT_PYTHON=1` is set.

The live test `src/app/skills.e2e.test.ts` has a real model turn a PDF and a CSV into `report.docx` through the office skill. It needs `DEEPSEEK_API_KEY` and Python 3.

## Provenance and staleness

Bundled skills carry two `metadata` keys MiniDSH ignores: `minidsh-reviewed`, the date someone last checked the skill against its helpers, and `minidsh-verified-with`, the model and run that last used it end to end. A skill is stale when either is old next to the models in use. To judge whether one earns its place:

- `minidsh sessions show <id>` prints each tool call of a session: whether a `SKILL.md` was read and a helper run.
- Set `MINIDSH_SKILLS_BASELINE=1` and run `pnpm test:e2e src/app/skills.e2e.test.ts`. That adds a reported run of the same task with the skills row disabled.
