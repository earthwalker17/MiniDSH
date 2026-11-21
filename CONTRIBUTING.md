# Contributing to MiniDSH

MiniDSH is built architecture-first: a change has a home and an owner before it has code. This page covers finding that home, running the checks and cutting a release.

## Read first

- [`README.md`](README.md): what the system is and how to run it.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the contract. §1 layers and the dependency rule, §3 ownership, §4 the session log, §7 authority, §11 where new things go, §13 known limitations.
- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md): what comes next, and what is refused and why.
- [`CLAUDE.md`](CLAUDE.md): the rules the sessions that wrote the system run under.

## Before writing code: find the home

ARCHITECTURE §11 is a table from a new thing to where it goes. If your change fits a row, name the row in the pull request. If it fits none, open an issue with the *architecture question* template before building. CLAUDE.md §2 lists what a change should state: its layer, seam, owned state, dependency direction and lifecycle. A pure helper, an algorithm or a type needs none of this.

## Toolchain

- **Node 24** (`.nvmrc`). The TypeScript source runs directly. `bin/minidsh.js` runs `src/` in a checkout and the emitted `dist/` in an installed package.
- **pnpm**, at the version `package.json` pins in `packageManager`: `corepack enable`, then `pnpm install`.
- **Windows:** PowerShell 7 (`pwsh`). **Linux:** `bubblewrap`.
- **Every host:** Chrome, Edge or Chromium for the browser tests, and Python 3 for the bundled skills' document check.
- Only the live tests need provider keys: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`. Never commit or log one.

```sh
pnpm install
pnpm check        # typecheck, oxlint, the dependency gate, the docs gate, vitest
pnpm test:e2e     # live tests ("arcs"), drift probes, desktop E2E: real provider calls
pnpm build        # emits dist/; prepack runs it
pnpm minidsh …    # run the checkout
```

[`desktop/README.md`](desktop/README.md) covers building the desktop app. Its E2E drives the app `MINIDSH_DESKTOP_EXE` names and, on Windows, the installer `MINIDSH_DESKTOP_INSTALLER` names.

A test whose tool is missing skips itself, and a skip looks like a pass. Each flag turns one skip into a failure. CI sets them.

| Flag | Fails when |
|---|---|
| `MINIDSH_EXPECT_SHELL=1` | the host's shell is missing (`pwsh` on Windows) |
| `MINIDSH_EXPECT_PYTHON=1` | no Python 3 |
| `MINIDSH_EXPECT_BROWSER=1` | no Chrome, Edge or Chromium |
| `MINIDSH_EXPECT_CONFINEMENT=1` | the host cannot confine a command (Linux, macOS) |
| `MINIDSH_EXPECT_KEYS=NAME,…` | a named provider key is unset (live tests) |
| `MINIDSH_EXPECT_DESKTOP=1` | the desktop E2E has no app to drive |

## What the gate enforces

`pnpm check` is the repository gate. Beyond type errors it enforces:

| Rule | Where |
|---|---|
| The dependency direction of ARCHITECTURE §1. Core has no import cycle at file level. `desktop/src` imports only `electron`, `node:*` and itself | `scripts/check-deps.ts` |
| An event payload is read through `matches(event, KIND)`, never a cast on `.data` | `scripts/check-deps.ts` |
| Document budgets (`node scripts/check-docs.ts --sections`), ARCHITECTURE's pinned headings, every relative link and `#fragment`, table row widths | `scripts/check-docs.ts` |
| Strict TypeScript with `exactOptionalPropertyTypes` and `erasableSyntaxOnly`: no enums, no parameter properties. Rewrite the code, do not relax a flag | `tsconfig.json` |
| oxlint, with warnings denied | `.oxlintrc.json` |

Tests mount real compositions and script or replay only the model: see [How the tests work](src/README.md#how-the-tests-work). A claim that spans capabilities is pinned in `src/app/app.test.ts`. End-to-end tests assert the file on disk, not the agent's account of it.

## Durable state lives in the log

State that must survive a restart, a resume or a fork is a log-only session event kind with a fold, never a field a surface holds (ARCHITECTURE §4).

## Commits and pull requests

- Small commits, each green under `pnpm check`.
- The pull request template asks for the boundary changed, why it belongs there, the invariants kept, the verification and the documentation impact.
- A change to documented behaviour changes `docs/ARCHITECTURE.md` in the same pull request, and a new or changed limitation is a line in its §13. Add a line to the section that owns the topic. Detail goes in a comment at the owning code.
- If a change touches authority, the session log or the protocol, say which live tests you ran. They cost money, so a maintainer may run them for you.

## Releases

A release is a `v<version>` tag on a commit of `main`. Before the tag:

1. Set one version in `package.json` and `desktop/package.json`. The packer refuses two.
2. Add a `## [<version>]` section to `CHANGELOG.md`. The release notes are cut from it.
3. Get the commit green in `check.yml` and in one `live.yml` run with a blank filter. `check.yml` runs on pushes to `main` and `release/**` and on pull requests: three gate legs (Linux, macOS, Windows) and four desktop legs (Windows, Linux, macOS arm64, macOS Intel). `live.yml` starts only by hand, because it spends provider credit.
4. Rehearse by starting `release.yml` by hand. That dry run stops before publishing: it reads its draft release back, verifies it, deletes it, and never reaches npm.

For a tag, `release.yml` runs four jobs:

- **gate** refuses a tag that is not on `main` or disagrees with `package.json`, and a commit that lacks a successful `check.yml` run or a successful unfiltered `live.yml` run. Then it runs `pnpm check`, packs and smoke-installs the tarball.
- **desktop** builds the four installers from that tarball, by the steps `check.yml` runs (`.github/actions/desktop-leg`).
- **assemble** requires exactly the installers `desktop/release-assets.json` names (no version in a name) plus the tarball, writes `SHA256SUMS`, drafts the GitHub release, downloads it again and checks every checksum.
- **publish** sends the tarball to npm through trusted publishing, installs it from the public registry, verifies its provenance attestation, then makes the draft public.

No npm token exists: the trusted publisher (`earthwalker17` / `MiniDSH` / `release.yml`) is configured once on npmjs.com. If a run fails, re-run only the failed jobs. Once npm holds a version, its tag never moves. The installers carry no publisher signature yet.

## Scope

BLUEPRINT §2 lists what is refused and why, and §3 the open questions. Open an issue before working on one: most are architecture decisions.

## License and attribution

Contributions are accepted under the MIT License. Credit anything adapted from DeepSeek Harness in the adjacent comment, as the existing code does (see [`NOTICE`](NOTICE)).
