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
pnpm minidsh sessions show <session-id>
```

Session logs live under `%USERPROFILE%\.minidsh\sessions` (override with `MINIDSH_HOME`). The default model is `deepseek-v4-flash`; pass `--model deepseek-v4-pro` or set `MINIDSH_MODEL`.

## License

MIT — see [`LICENSE`](LICENSE).
