# Skills

A skill is a directory holding a `SKILL.md`, in the open [Agent Skills](https://agentskills.io) format: YAML front-matter with a `name` and a `description`, then Markdown instructions, sometimes with scripts or reference files beside it. This directory holds the skills MiniDSH ships: `office` (.docx, .xlsx, .pptx) and `pdf`.

MiniDSH treats a skill as data, never as code or authority:

- At every prompt, MiniDSH shows the model the name, description and absolute path of each available skill, as optional context. The list is re-read on every prompt and re-entered only when it changes.
- The model reads a `SKILL.md` with its ordinary file tools, and only when the description fits the task. There is no skill tool and no `/name` command.
- A skill's scripts run as ordinary shell commands, under the session's sandbox, acceptance mode and approvals. A skill cannot register tools, hooks, models or permissions, and it grants nothing.

## Where skills come from

Skills are looked up one level deep, as `<root>/<name>/SKILL.md`, under three kinds of root:

| origin | where | notes |
|---|---|---|
| `user` | `$MINIDSH_HOME/skills` (default `~/.minidsh/skills`) | yours; wins every name |
| `bundled` | this `skills/` directory, inside the installed package | replaced by a user skill of the same name |
| `workspace` | `.agents/skills` and `.claude/skills` in each directory from the session's cwd up to the project root (the `.git` directory) | the nearest one wins among workspace roots |

Precedence is user, then bundled, then workspace. A repository's skill never replaces one of yours or a bundled one: a workspace skill whose name is taken is not listed, and the operator gets a warning on stderr. Skills in other tools' home folders, such as `~/.claude/skills`, are reached only through the `skills` row's `roots` config, which then lists every user and bundled root to scan (absolute paths). One exception: when your home folder is itself a git checkout (a dotfiles repository), a session started anywhere under it with no `.git` of its own climbs to that one, so `~/.claude/skills` is read as a workspace root. On Linux and macOS, a `.git` above the cwd that another user owns ends the walk at the cwd instead.

Run `minidsh skills` to see what a new session in the current directory would be offered, what was skipped and why, and the effective roots. It takes `--json`, `--cwd <dir>` and `--patch <file>`.

## Adding, replacing, disabling, removing

- **Add** a skill: create `~/.minidsh/skills/<name>/SKILL.md`. It is listed from the next prompt on.
- **Replace** a bundled skill: put a user skill with the same name in your home `skills/` directory.
- **Hide** some skills: `{"patches": [{"id": "skills", "config": {"maxBytes": 8000, "exclude": ["pdf"]}}]}` in `~/.minidsh/composition.json` or a `--patch` file. A patch replaces the row's whole config, so restate `maxBytes`; leaving `roots` out keeps the default roots, while `"roots": []` removes them.
- **Turn skills off** entirely: `{"patches": [{"id": "skills", "disabled": true}]}`. That applies to sessions started after it; a resumed session keeps the list it already has. To retire the list in running and resumed sessions too, keep the row and empty it: `{"id": "skills", "config": {"maxBytes": 8000, "roots": [], "workspaceDirs": []}}`.
- **Keep one of your skills unlisted**: set `disable-model-invocation: true` in its front-matter.
- **Remove** a skill: delete its directory.

## Writing a skill

- Front-matter `name` is lowercase letters, digits and single hyphens (at most 64 characters), and equals the directory name. `description` (at most 500 characters is what the list shows) says what the skill does and when to use it, in words a model can match against a task.
- Keep `SKILL.md` small and route to reference files that the model reads only when it needs them. A model's file reader may cut long results: keep every file under 8 KB as the reader shows it, with line numbers.
- Write for a capable model: only what it would not know, worded as optional know-how, not as commands.
- Show every script invocation with a quoted absolute path built from the skill's own directory, run from the model's working directory. Scripts take `--help`, print JSON or bounded text, put errors on stderr with a non-zero exit code, never prompt, and write only the output path they are given, never inside the skill directory.
- Verification is the reopened output checked against the request. When nothing could render the result, say so in one plain sentence.

## Provenance and staleness

Bundled skills carry two front-matter keys that MiniDSH itself ignores:

```yaml
metadata:
  minidsh-reviewed: "2026-10-18"
  minidsh-verified-with: "<model>, skills arc"
```

`minidsh-reviewed` is the date someone last checked the skill against its helpers and against what current models need. `minidsh-verified-with` is the model and run that last used it end to end. Treat a skill as stale when either is old next to the models in use or the formats it handles. To judge whether a skill still earns its place:

- The session log records the skill list the model saw and every tool call that read a `SKILL.md` or ran a skill's script (`minidsh sessions inspect <id>`).
- Run the live `skills` arc with and without the skill: a patch file holding `{"patches": [{"id": "skills", "disabled": true}]}` gives the baseline. If the model does as well without it, the skill is dead weight.
