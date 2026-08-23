# MiniDSH

An architecture-first, local-first, **minimal but architecturally complete** coding-agent harness.

MiniDSH studies [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an architecture textbook and re-derives a much smaller runtime that keeps the properties that matter: an event-sourced session log as the only truth, a microkernel agent loop with typed extension points, capability seams (definition / provider / consumer), reversible registrations, policy separated from model reasoning, and one runtime shared by every surface. It is an independent educational and engineering project, not an official DeepSeek project.

> **Minimal surface. Complete architecture.**

## Documents

- [`PROJECT.md`](PROJECT.md) — thesis, positioning, research context.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the implemented system shape (current state).
- [`BLUEPRINT.md`](BLUEPRINT.md) — the long-term route and the compact development record.
- [`CLAUDE.md`](CLAUDE.md) — project constitution and execution rules.

## Quick start

Requirements: Node ≥ 24 (TypeScript runs natively, no build step), pnpm 11, a DeepSeek API key in the environment variable `DEEPSEEK_API_KEY`.

```sh
pnpm install
pnpm check                                  # typecheck + lint + dependency gate + tests
pnpm minidsh run "fix the failing test" --cwd path/to/workspace --approve
pnpm minidsh run "summarize this repo" --json   # one JSON line per session event on stdout
pnpm minidsh chat --cwd path/to/workspace       # interactive terminal (y/N approvals, /sandbox, /exit)
pnpm minidsh sessions show <session-id> --audit  # what this session was allowed to do, and when
```

Session logs live under `%USERPROFILE%\.minidsh\sessions` (override with `MINIDSH_HOME`). The default model is `deepseek-v4-flash`; pass `--model deepseek-v4-pro` or set `MINIDSH_MODEL`.

**Authority.** Runs default to `--sandbox workspace-write`: file modifications are fenced to the working directory in process, and reads are unrestricted. No host can confine shell commands yet, so the shell refuses to run under a confined mode and the model must ask for a one-shot escalation, which a person approves (`--approve` grants them in a headless run, `--sandbox danger-full-access` drops confinement for the whole session). Every mode, policy, request and decision is a durable event you can read back with `sessions show --audit`.

## License

MIT — see [`LICENSE`](LICENSE).
