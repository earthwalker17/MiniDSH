<!-- These are the questions every change to MiniDSH answers before it is built (CLAUDE.md §6). Short answers are fine; "none" is an answer. -->

## The boundary being changed

<!-- Which layer, subsystem and seam. If ARCHITECTURE §11 has a row for this kind of thing, name it. -->

## Why the change belongs there

<!-- What it owns, what it must not own, and which direction its dependencies point. -->

## Invariants and contracts preserved

<!-- The documented behaviours near this change that still hold — and any that deliberately no longer do, with the `docs/ARCHITECTURE.md` edit that says so. -->

## Verification

- [ ] `pnpm check` green locally with every flag your host can meet — `MINIDSH_EXPECT_SHELL=1`, `MINIDSH_EXPECT_PYTHON=1`, `MINIDSH_EXPECT_BROWSER=1`, and `MINIDSH_EXPECT_CONFINEMENT=1` on Linux/macOS — because without them a suite whose tool is missing skips, and a skip looks like a pass
- [ ] Tests mount a real composition; a claim that spans capabilities is pinned in `src/app/app.test.ts`
- [ ] Live arcs run, if authority, the session log or the protocol changed, with `MINIDSH_EXPECT_KEYS` naming every key the run promises (each arc self-skips without its key — DeepSeek for all, Anthropic, OpenAI and Tavily for theirs; see `vitest.e2e.config.ts`): <!-- which ones, and how many times -->

## Documentation impact

- [ ] `docs/ARCHITECTURE.md` updated where a documented behaviour changed (it is a contract, not a history)
- [ ] `docs/ARCHITECTURE.md` §13 updated where a limitation was added, removed or changed
- [ ] `README.md` updated where a user-facing command, flag, default or file moved
