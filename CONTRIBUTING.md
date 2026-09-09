# Contributing to MiniDSH

MiniDSH is an architecture-first project. Before it is a set of features, it is a set of answers: which layer a thing lives in, who owns what state, which direction dependencies point, and where the truth of an execution is recorded. A contribution is welcome when it keeps those answers clear, and the fastest way to get one merged is to start from the architecture rather than from the code.

## Read first

- [`README.md`](README.md) — what the system is and how to run it.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the contract. Layers and the dependency rule (§1), what each service owns and must not own (§3), the session log (§4), the tool pipeline (§6), authority (§7), surfaces (§8), **where new things go (§11)**, deliberate divergences from DeepSeek Harness (§12) and the known limitations (§13).
- [`BLUEPRINT.md`](BLUEPRINT.md) — what comes next, what is out of scope for now and why, and the development record.
- [`PROJECT.md`](PROJECT.md) — the thesis.

`CLAUDE.md` is the working constitution the coding-agent sessions that built the system run under. It is short, and it explains why the commits, the documents and the verification look the way they do.

## Before writing code: find the home

Every capability has an architectural home before it has an implementation. ARCHITECTURE §11 is a table from "new thing" to "where it goes". If your change fits a row, name the row in the pull request. If it fits no row, that is an architecture question rather than an implementation task: open an issue with the *architecture question* template before building anything. The discussion is the contribution.

The questions a change should be able to answer (CLAUDE.md §2):

- its layer and owning subsystem;
- the seam or contract it implements;
- the state it owns and the state it must not own;
- the dependency direction;
- its lifecycle and effects — how it is persisted, observed, verified and removed.

A pure helper, an algorithm or a type does not need any of this. Architecture-first is not abstraction-first.

## Toolchain

- **Node 24** (`.nvmrc`). TypeScript runs natively; there is no build step in development. `bin/minidsh.js` runs the source in a checkout and the emitted `dist/` in an installed package.
- **pnpm**, the version pinned in `package.json`'s `packageManager`: `corepack enable`, then `pnpm install`.
- **Windows:** PowerShell 7 (`pwsh`) — the shell tool and its tests refuse to run under PowerShell 5.1. **Linux:** `bubblewrap` for the confinement tests. **macOS:** nothing extra.
- Provider keys (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`) are needed only by the live arcs. They are never committed, never logged, and read only through the credential seam.

```sh
pnpm install
pnpm check          # tsc --noEmit + oxlint + the dependency gate + vitest
pnpm test:e2e       # the eight live arcs: real provider calls, real cost, needs the keys
pnpm build          # emits dist/ — what the package runs; `prepack` runs it for you
pnpm minidsh …      # run the checkout
```

Set `MINIDSH_EXPECT_SHELL=1` on every host, and `MINIDSH_EXPECT_CONFINEMENT=1` on Linux and macOS, so a test that would self-skip for a missing shell or backend fails instead. That is what CI does, and it is the difference between "green" and "green having proved nothing".

## What the gate enforces

`pnpm check` is the repository gate, and it fails on more than type errors:

| Rule | Where |
|---|---|
| Dependency direction: `kernel` imports nothing internal; `core` imports `kernel` and other `core` contracts (nothing but `app` imports `core/loop`); a capability imports `kernel` and `core` Definitions, never another capability and never `app`; `app` imports anything | `scripts/check-deps.ts` |
| An event payload is read through `matches(event, KIND)`, never `event.data as {…}`, so a renamed field is a type error and not a `NaN` on a screen | `scripts/check-deps.ts` |
| Core is acyclic at file level: each package's vocabulary (`events.ts`, `types.ts`) sits below its service | `scripts/check-deps.ts` |
| Strict TypeScript including `exactOptionalPropertyTypes` and `erasableSyntaxOnly` — no enums, no parameter properties; rewrite rather than relax the flag | `tsconfig.json` |
| oxlint with the `correctness` category as errors | `.oxlintrc.json` |

Tests mount real compositions through the kernel (`src/test-support/harness.ts`); only the model is scripted (`scripted-adapter`) or replayed from a recorded session log (`llm-replay`). Hand-wired mocks of services are not the house style, because a claim that spans capabilities is only true in the composition that ships — `src/app/app.test.ts` pins those against the full one. End-to-end tests assert the world (the file on disk, the test that now passes), never the agent's own account of it.

## Durable state lives in the log

If a change needs state that must survive a restart, a resume or a fork, it is a new **log-only** session event kind with a fold — never a field a surface holds, and never a mutation of one of the three surface kinds. ARCHITECTURE §4 has the rules; the session invariants reject what they can before it enters the log.

## Commits and pull requests

- Small, focused commits, each green under `pnpm check`.
- The pull request template asks for the boundary being changed, why the change belongs there, the invariants preserved, how it was verified, and the documentation impact. These are the questions the sessions that built the system answer in their plans; they are not ceremony.
- **`ARCHITECTURE.md` is a contract, not a history.** A pull request that changes documented behaviour changes the document in the same pull request. Documentation drift is a defect here, and the development record says what it has cost.
- A new or changed limitation is a line in ARCHITECTURE §13. A limitation that is stated is a contract; one that is not is a bug report waiting to happen.
- If a change touches authority, the session log or the protocol, say which live arcs you ran. They cost money, so a maintainer may run them for you — say so rather than skipping them silently.

## Scope

BLUEPRINT §2 lists what V1 deliberately does not do — background jobs and parallel tool calls, an MCP client, model-written extensions and PTC, a Windows confinement backend and Landlock, standing approval grants, session deletion, a session search index, per-user identity, a desktop shell — each with the reason; the README's *Not built* list is the same list. A pull request for one of those is not refused on principle, but open an issue first: most of them are architecture decisions with a pending question in BLUEPRINT §3, and a good implementation of the wrong shape is the expensive kind of contribution.

## License and attribution

Contributions are accepted under the MIT License. MiniDSH is an independent project; where you adapt a contract, a profile or wording from DeepSeek Harness, credit the source in the adjacent comment, as the existing code does (see [`NOTICE`](NOTICE)).
