# MiniDSH

An architecture-first, local-first, **minimal but architecturally complete** coding-agent harness.

MiniDSH studies [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an architecture textbook and re-derives a much smaller runtime that keeps the properties that matter: an event-sourced session log as the only truth, a microkernel agent loop with typed extension points, capability seams (definition / provider / consumer), reversible registrations, policy separated from model reasoning, the model as a routed capability rather than the agent itself, and one runtime shared by every surface. It is an independent educational and engineering project, not an official DeepSeek project.

> **Minimal surface. Complete architecture.**

## Documents

- [`PROJECT.md`](PROJECT.md) — thesis, positioning, research context.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the implemented system shape (current state), what it deliberately differs on, and what it knowingly lacks.
- [`BLUEPRINT.md`](BLUEPRINT.md) — the route to V1 and the compact development record.
- [`CLAUDE.md`](CLAUDE.md) — project constitution and execution rules.

## Quick start

Requirements: Node ≥ 24 (TypeScript runs natively, no build step); pnpm 11 (`corepack enable`, or `npm i -g pnpm`); on Windows, PowerShell 7 (`pwsh`) — the shell tool refuses loudly if it is missing; and a provider key: `DEEPSEEK_API_KEY` for the default route, `ANTHROPIC_API_KEY` for the Anthropic one, either in the environment or in `~/.minidsh/credentials.json` as `{"DEEPSEEK_API_KEY": "…"}` (only the name is ever logged). Today MiniDSH runs from a clone; an npm package is the V1 release step.

```sh
pnpm install
pnpm check                                  # typecheck + lint + dependency gate + tests
pnpm minidsh run "fix the failing test" --cwd path/to/workspace --approve
pnpm minidsh run "review this module" --provider anthropic --model claude-sonnet-5
pnpm minidsh run "summarize this repo" --json   # one JSON line per session event on stdout
pnpm minidsh chat --cwd path/to/workspace       # interactive terminal
pnpm minidsh web  --cwd path/to/workspace       # the same runtime in a browser; open the one URL it prints
pnpm minidsh sessions show <session-id> --audit  # what this session was allowed to do, and when
pnpm minidsh --help
```

In the terminal: `y`/`N` answers an approval; `/sandbox <mode>`, `/ask <ask|never>` and `/preset <name>` switch authority; `/model [<provider>/]<model> [effort]` switches the route; `/compact` shrinks context; `/history` pages back; `/cancel` stops the running turn; `/exit` quits; Ctrl+C cancels, then exits.

Session logs live under `~/.minidsh/sessions` (override the home with `MINIDSH_HOME`); a session is stored the moment it records its first prompt, so a `chat` opened and closed leaves nothing behind. Logs accumulate: nothing in the harness deletes one, and a log with no `.lock` beside it can be removed by hand. A `composition.json` row with a key its plugin does not know fails boot naming the row rather than taking a default silently.

**Models.** Two providers ship — DeepSeek (`deepseek-v4-flash` by default, `deepseek-v4-pro`, a vision model) and Anthropic (`claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`) — and a session's route is a durable fact it can change mid-conversation: `--provider`/`--model` on a run, `/model anthropic/claude-sonnet-5` in the terminal, `session/model` over the wire. The log records the base route, the effective route and each model's real context window, so a switch is visible, meterable and replayable, and every assistant message says which model wrote it. A `model-roles` row maps a *purpose* to a route — the compaction summary on a cheap model, a delegated child on another — without touching what the conversation itself runs on.

**Delegation.** The model can hand one bounded task to a `subagent`: a child agent with its own session and its own log that starts empty, does the work, and answers once. Its authority is its parent's or narrower, fixed at the moment it starts and impossible to widen from inside — approvals are off, so an action needing one is refused rather than escalated, and the child cannot delegate further past the depth cap. `minidsh sessions list` shows a child under the session that delegated it; `sessions show <child> --audit` reads the authority it ran under. A verifier that can *see* is the same tool mounted a second time with a vision route: `view_image` is a built-in row a `composition.json` enables, not a default tool.

**Context.** A long session compacts itself when the projected request nears the model's window (on the DeepSeek default that is a 1M window, so set `budgetTokens` on the `compaction` row to compact earlier): the oldest history is replaced by a summary and the shadowed events stay in the log — nothing is rewritten, and `sessions show` still reads the whole thing. The terminal shows pressure as `[ctx 34% · 12.4k/32k]` and `/compact` forces it early. Command output too large to show inline is saved under `~/.minidsh/spill/<session>/` and the model is told where to read it. An `AGENTS.md` (or `CLAUDE.md`) in the workspace is entered as context, from the project root down to the working directory — instructions to the model only; a repository can never change what the harness is allowed to do.

**Surfaces.** One runtime, one client protocol, three ways in: the headless CLI, an interactive terminal, and a browser. The terminal and the browser are both protocol *clients* — the terminal over an in-process stream pair, the browser over a WebSocket — so neither holds any semantics of its own. A long session is served by the page rather than whole: attaching returns a message-aligned tail, `/history` (or a click) walks backwards, and the numbers a client cannot compute from one page — context pressure, the open approvals, the authority and the route — are folded by the host and sent. Several clients can watch one session at once; a browser tab closing ends nothing.

**Authority.** Runs default to `--sandbox workspace-write` with approvals `ask`: file modifications are fenced to the working directory in process, and reads are unrestricted. No host can confine shell commands yet, so under a confined mode the shell refuses to run and the model asks for a one-shot escalation, which a person approves — in the terminal or the browser once per command, or for a headless run with `--approve`, which grants every request. `--sandbox danger-full-access` (or `--preset danger-full-access`, and `/preset` in the terminal) drops confinement for the whole session, which is what an unattended shell-heavy run uses today; the first approval prompt says so. A headless `run` without `--approve` can edit files but cannot run a shell command. Every session opens by recording the mode and the approval policy it starts under, and every switch, request and decision is a durable event you can read back with `sessions show --audit`. A protocol client (`minidsh serve`, `minidsh web`) may pick a session's working directory only inside the host's workspace roots. `minidsh web` binds loopback and prints a one-shot URL whose token becomes a signed cookie: it is a surface that can write files and run commands, so reaching it is meant to be deliberate.

## License

MIT — see [`LICENSE`](LICENSE).
