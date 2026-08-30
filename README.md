# MiniDSH

An architecture-first, local-first, **minimal but architecturally complete** coding-agent harness.

MiniDSH studies [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an architecture textbook and re-derives a much smaller runtime that keeps the properties that matter: an event-sourced session log as the only truth, a microkernel agent loop with typed extension points, capability seams (definition / provider / consumer), reversible registrations, policy separated from model reasoning, the model as a routed capability rather than the agent itself, and one runtime shared by every surface. It is an independent educational and engineering project, not an official DeepSeek project.

> **Minimal surface. Complete architecture.**

## Documents

- [`PROJECT.md`](PROJECT.md) — thesis, positioning, research context.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the implemented system shape (current state).
- [`BLUEPRINT.md`](BLUEPRINT.md) — the long-term route and the compact development record.
- [`CLAUDE.md`](CLAUDE.md) — project constitution and execution rules.

## Quick start

Requirements: Node ≥ 24 (TypeScript runs natively, no build step), pnpm 11, and a provider key in the environment — `DEEPSEEK_API_KEY` for the default route, `ANTHROPIC_API_KEY` to use the Anthropic one.

```sh
pnpm install
pnpm check                                  # typecheck + lint + dependency gate + tests
pnpm minidsh run "fix the failing test" --cwd path/to/workspace --approve
pnpm minidsh run "review this module" --provider anthropic --model claude-sonnet-5
pnpm minidsh run "summarize this repo" --json   # one JSON line per session event on stdout
pnpm minidsh chat --cwd path/to/workspace       # interactive terminal (y/N approvals, /sandbox, /compact, /exit)
pnpm minidsh sessions show <session-id> --audit  # what this session was allowed to do, and when
```

Session logs live under `%USERPROFILE%\.minidsh\sessions` (override with `MINIDSH_HOME`); a session is stored the moment it records its first prompt, so a `chat` opened and closed leaves nothing behind. A `composition.json` row with a key its plugin does not know fails boot naming the row rather than taking a default silently.

**Models.** Two providers ship — DeepSeek (`deepseek-v4-flash` by default, `deepseek-v4-pro`, a vision model) and Anthropic (`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-haiku-4-5`) — and a session's route is a durable fact it can change mid-conversation: `--provider`/`--model` on a run, `/model anthropic/claude-sonnet-5` in the terminal, `session/model` over the wire. The log records the base route, the effective route and each model's real context window, so a switch is visible, meterable and replayable, and every assistant message says which model wrote it. A `model-roles` row maps a *purpose* to a route — the compaction summary on a cheap model, a delegated child on another — without touching what the conversation itself runs on.

**Delegation.** The model can hand one bounded task to a `subagent`: a child agent with its own session and its own log that starts empty, does the work, and answers once. Its authority is its parent's or narrower, fixed at the moment it starts and impossible to widen from inside — approvals are off, so an action needing one is refused rather than escalated, and the child cannot delegate further past the depth cap. `minidsh sessions list` shows a child under the session that delegated it; `sessions show <child> --audit` reads the authority it ran under.

**Context.** A long session compacts itself: when the projected request nears the model's window, the oldest history is replaced by a summary and the shadowed events stay in the log — nothing is rewritten, and `sessions show` still reads the whole thing. The terminal shows pressure as `[ctx 34% · 12.4k/32k]` and `/compact` forces it early. Command output too large to show inline is saved under `.minidsh/spill/` and the model is told where to read it. An `AGENTS.md` (or `CLAUDE.md`) in the workspace is entered as context, from the project root down to the working directory — instructions to the model only; a repository can never change what the harness is allowed to do.

**Authority.** Runs default to `--sandbox workspace-write`: file modifications are fenced to the working directory in process, and reads are unrestricted. No host can confine shell commands yet, so the shell refuses to run under a confined mode and the model must ask for a one-shot escalation, which a person approves (`--approve` grants them in a headless run, `--sandbox danger-full-access` drops confinement for the whole session). Every session opens by recording the mode and the approval policy it starts under, and every switch, request and decision is a durable event you can read back with `sessions show --audit`. A protocol client (`minidsh serve`) may pick a session's working directory only inside the host's workspace roots.

## License

MIT — see [`LICENSE`](LICENSE).
