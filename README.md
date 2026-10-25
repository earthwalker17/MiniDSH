# MiniDSH

[![npm](https://img.shields.io/npm/v/minidsh)](https://www.npmjs.com/package/minidsh)
[![check](https://github.com/earthwalker17/MiniDSH/actions/workflows/check.yml/badge.svg)](https://github.com/earthwalker17/MiniDSH/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node ≥ 24](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)

![MiniDSH: an architecture-first, local-first agent harness](https://raw.githubusercontent.com/earthwalker17/MiniDSH/main/docs/images/README_hero.png)

> **Minimal surface. Complete architecture.**

MiniDSH is a small, local-first coding-agent harness: the runtime around a model that gives it tools, sessions and permissions. Install it, point it at a repository, and use it from a terminal, a browser or a script. It is also a reference architecture small enough to read in a sitting, and an experiment in growing an AI-assisted system *architecture-first* rather than feature by feature.

It studies [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — DeepSeek's open-source, plugin-composed and unusually well documented coding agent — as a textbook, and asks how small a system can be while keeping the same architectural properties. It is an independent project: not a fork, not a product, and not affiliated with DeepSeek.

## What MiniDSH is

Three things:

1. **Useful software.** A coding agent that edits files and runs commands under an authority you set — which files it may write, and which actions need your approval — and can audit afterwards; that survives its process being killed and can be resumed or forked from its log; that manages its own context; that can hand a bounded task to a child or a visual check to a model that can see. Three providers ship (DeepSeek, Anthropic and OpenAI), and a session can switch models mid-conversation.
2. **A reference architecture.** About thirty-three thousand lines of TypeScript in one package with one runtime dependency: four layers with a dependency rule enforced by a script in `pnpm check`, eighteen service contracts in core plus one in the application, thirty-four durable event kinds, and one document — [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) — that says where every new thing goes.
3. **A systems-engineering experiment.** Whether a project built almost entirely by coding-agent sessions can keep a global architecture intact across months, by making it explicit, inspectable and continuously falsified rather than letting sessions gradually invent it.

The thesis is **fewer concepts and stronger invariants**, not fewer lines or more features.

## Quick start

Requirements:

- **Node 24** or newer.
- **Windows:** PowerShell 7 (`pwsh`), never 5.1; a missing `pwsh` is refused by name. Windows has no shell confinement, so a shell command there is refused until the session accepts that (`--accept none`) — see [Status and limitations](#status-and-limitations).
- **Linux:** `bubblewrap` (`apt install bubblewrap`) if you want shell commands confined by the operating system instead of approved one by one. **macOS** needs nothing extra.
- **A provider key:** `DEEPSEEK_API_KEY` for the default provider, `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI (and `TAVILY_API_KEY` for the opt-in web search) — in the environment, or in `~/.minidsh/credentials.json` as `{"DEEPSEEK_API_KEY": "…"}`. A run without one stops and names the key it expected.

```sh
npm install -g minidsh            # or run it without installing: npx minidsh …

minidsh chat --cwd path/to/repo   # interactive terminal (--cwd defaults to the current directory)
minidsh web  --cwd path/to/repo   # the same runtime in a browser; open the one URL it prints
minidsh run "fix the failing test in src/slug.test.mjs" --approve
                                  # --approve answers every approval yes (chat, serve and web then never ask);
                                  # without it a headless run refuses anything that needs one (on Windows: add
                                  # --accept none, which runs shell commands unconfined but keeps file edits fenced)
minidsh run "review this module for unchecked inputs" --provider anthropic --model claude-sonnet-5
minidsh run "summarize this repository" --json     # one JSON line per session event on stdout

minidsh sessions list                     # what is stored, by name
minidsh sessions show <id> --audit        # what this session was allowed to do, and what each call did
minidsh sessions verify <id>              # can this log be resumed? (exit 0 for ok, interrupted and torn; 1 for
                                          # damaged, invalid or a newer format; reads it without resuming it)
minidsh sessions inspect <id>             # its lifecycles, authority, and what a resume would append
minidsh resume <id> "continue"            # pick a stored session up; fork <id> --at <seq> branches it at a turn boundary
                                          # (fork <id> --salvage branches a damaged log from what is still readable)
minidsh config                            # the effective plugin composition, and which file set each entry
minidsh skills                            # the skills a session here is offered, and why the others are not
minidsh --help
```

In the terminal: `y`/`N` answers an approval, and `a` — when it is offered — allows that exact call for the rest of this run of the session (a resume or a fork asks again; `/grants` lists what you have allowed, `/revoke <id>` takes one back); `/sandbox <read-only|workspace-write|danger-full-access>`, `/ask <ask|never>`, `/accept <full|none>` and `/preset <name>` switch authority; `/model [<provider>/]<model> [effort]` switches the model; `/compact` shrinks context; `/history` pages back; `/sessions` lists recent sessions; `/cancel` stops the running turn; `/exit` quits. Typing while a turn is running steers it.

Everything MiniDSH keeps lives under `~/.minidsh` (override with `MINIDSH_HOME`): `sessions/` (one JSONL log per session), `spill/` (oversized tool output, swept after 30 days), `attachments/` (images, never swept), `composition.json`, `settings.json`, `credentials.json`, `skills/` (your own skills), and an optional `AGENTS.md` that every session reads. Nothing in the harness deletes a log.

From a checkout: `pnpm install`, then `pnpm minidsh …` (TypeScript runs natively on Node 24, so there is no build step to run it; `pnpm build` only emits the `dist/` the tarball ships) and `pnpm check` for the whole verification suite. See [`CONTRIBUTING.md`](CONTRIBUTING.md), and read [Status and limitations](#status-and-limitations) before relying on it.

## What you get

**Authority you set, and a record you can read back.** A run defaults to `workspace-write` with approvals `ask`: file writes are restricted to the working directory, reads are unrestricted, and shell commands are confined by the operating system where it can (bubblewrap on Linux, Seatbelt on macOS). An approval shows what the runtime says the call will do — the command itself and the authority it would run under — with the model's reason beside it rather than instead of it. Every session records the authority it starts under and every later switch, request and decision; `sessions show --audit` prints that history back.

**Sessions that survive their process.** Everything the model was shown and did is one append-only JSONL log. Kill the process mid-turn and the next `resume` repairs the tail and continues under the authority the log recorded. A second process cannot resume a session another one holds.

**Context that manages itself.** Near the model's window, or when the provider refuses a request as too large, the oldest history is replaced by a summary (*compaction*); the summarized events stay in the log, and the model can read them back with `history_read`. An `AGENTS.md` (or `CLAUDE.md`) in the workspace enters as instructions to the model, never permissions for the harness.

**Switch models mid-conversation.** The route — provider, model, reasoning effort — is a durable fact a session can change at any point. A `model-roles` entry in `composition.json` maps a *purpose* — the compaction summary, a delegated child — to a different route. An option a provider cannot honour is refused, never silently dropped. The DeepSeek adapter ships `deepseek-flash` (the default, which reads images; the retired `deepseek-v4-flash` names are served as it) and the text-only `deepseek-v4-pro`; the Anthropic adapter the Claude 5.5, 5 and 4 families; the OpenAI adapter the GPT-6 and GPT-5 families on the Responses API.

**Delegation with a ceiling.** The model can hand one bounded task to a `subagent`: a child with its own session and log whose authority is fixed at its parent's or narrower and cannot be widened from inside; approvals are off, so an action needing one is refused. A verifier that can *see* is a second `subagent` entry pointed at a vision model, using the `view_image` tool, a built-in row that is off by default.

**Background jobs that report back.** The model can start a long command — a dev server, a slow test run — with `job_start`, keep working, read its output with `job_output` and stop it with `job_cancel`. When a job ends on its own, its notice arrives in the session and wakes an idle agent, a bounded number of times. A job runs under the session's own authority and ends with its session.

**A real browser to check a frontend.** Where Chrome, Edge or Chromium is installed, the model can open a page (a dev server it started as a job, or a workspace file), read it as an accessibility tree, click, type, take a screenshot and run JavaScript; each result says what the page logged or failed. It reaches only localhost and the workspace's own files, enforced inside the browser.

**Web search, when you mount it.** One `composition.json` row adds `web_search` (Tavily). Every query asks first, naming the exact text that would leave the machine, where it goes and under which credential; results are titles, URLs and snippets behind a fixed untrusted-content notice. A delegated child is not offered it.

**Skills: know-how as data.** A skill is a folder holding a `SKILL.md` (the open [agentskills.io](https://agentskills.io) format) in `~/.minidsh/skills/` or a repository's `.agents/skills/` or `.claude/skills/`. A session is shown a short list of them, and the model reads one with its ordinary file tools when a task fits: advice, never a permission. Two ship, both on Node alone: `office` (create, read and edit .docx, .xlsx, .pptx) and `pdf`. A repository's skill never replaces yours.

**Composition from disk.** The default composition is a list of forty-one plugin entries (*rows*); `~/.minidsh/composition.json` and `--patch` files override it. A row can be disabled, reconfigured or replaced by module specifier; `minidsh config` flags any authority-sensitive row a file changed.

**One runtime, three ways in.** The headless CLI, the terminal and the web UI are clients of one runtime speaking one newline-delimited JSON-RPC protocol (`minidsh serve` exposes it on stdio for your own client). Several clients can watch one session, and a browser tab closing ends nothing but an approval only that tab could have answered, which is refused on the record.

## Status and limitations

**Version 1.2.0** is the smallest release a developer can install, point at a repository and use daily without reading the architecture. 1.1 added durable execution with a cold `sessions verify` and `inspect`, a trusted consent subject on every approval, and a session that can accept the enforcement its host delivers; 1.2 adds background jobs, OpenAI as a third provider, opt-in web search, skills (Office and PDF documents on Node alone) and a fenced browser for checking a frontend, all reviewed together before release. It is a small project with one maintainer. The full register of limitations is [ARCHITECTURE §13](docs/ARCHITECTURE.md); the ones most likely to matter first:

- Windows has no shell-confinement backend and is not getting one. By default a shell command there costs an approval and runs in a fresh shell (`cd` and environment changes do not persist); `--accept none` records that the session accepts an unconfined shell and runs it normally, with file edits still fenced, instead of `danger-full-access`, which drops the fence too.
- Confinement governs file effects only. A confined command still reaches the network. Its environment is scrubbed of this deployment's declared provider keys and of `MINIDSH_*`, and of nothing else: a credential-shaped variable you set is yours and reaches the shell. That scrub is defence in depth, not a boundary: reads are unfenced, so a credentials file stays readable to a command that looks.
- The filesystem fence resolves symbolic links but cannot detect hard links: a hard link inside the workspace to an outside file is written through. A confined shell writes through such a link too, because the OS confines paths; neither backend lets it create one across the workspace boundary (measured under bubblewrap and Seatbelt).
- Tool execution is sequential and a delegated child is foreground. A background job's process can outlive a MiniDSH process that is killed (on Windows, on macOS, and unconfined on Linux): the resume reports it lost and does not stop it. On Windows a job runs only in a session that accepts an unconfined shell (`--accept none`), and a program a job leaves running after its own command has ended is not stopped with it.
- Nothing confines the network: web search is consent per query, and there is no `web_fetch`. The browser is fenced from the internet, not from localhost: it reaches every local service, from any sandbox mode and a delegated child. No session deletion, search or rename; composition changes need a restart. Loading a plugin from an installed `minidsh` is unproven (BLUEPRINT §3).

What comes next is more than one actor: delegated children that can be continued without losing their narrowing, and job containment on Windows ([BLUEPRINT §2](docs/BLUEPRINT.md)).

## The question it investigates

The failure mode it answers is *architectural accretion*: each coding-agent session ships a feature cluster that passes its tests, features acquire local homes rather than principled ones, ownership blurs, and every later session must rediscover why the system looks the way it does ([`PROJECT.md`](docs/PROJECT.md)).

DSH's answer to that pressure is explicit: an *everything-is-a-plugin* harness built on [Cordis](https://github.com/cordiverse/cordis), whose [paper](https://github.com/cordiverse/paper) names the two properties that make dynamic composition sound — *temporal composability* (a component's effects can be fully reverted on removal) and *spatial composability* (dependencies are declared and reacted to). The question MiniDSH asks of that textbook is:

> **What is the minimum modern agent harness that still preserves the architectural properties required for long-term composition, observability, verification, multi-surface evolution and maintainability?**

"Minimum" is measured in concepts, not lines. The working rule is **everything evolvable has a seam** — a composition boundary — and not everything is evolvable: a capability earns one when it may realistically need to be replaced, scoped, disabled or owned by a different lifecycle; a pure helper or a type does not. The answer is concrete: a kernel with five mechanisms, nineteen seams, and everything else ordinary code.

## Architecture

This is a reading guide; [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the contract. One word to hold while reading: a **fold** is a pure derivation over the session log (the model's history, the current authority and the context pressure are all folds).

### Layers and the dependency rule

```
src/app/            application assembly and user interfaces: composition, disk config, CLI, terminal, web UI, stdio host
src/capabilities/   providers and consumers over core seams — never import each other, never app
src/core/           the spine: the service contracts (Service Definitions) and their default drivers as plugins
src/kernel/         composition substrate: Context, plugin lifecycle, services, effects, events
src/test-support/   scripted adapter, replay-from-log adapter, composition harness
```

A script in `pnpm check` enforces the dependency direction (ARCHITECTURE §1) and that `core` is acyclic at file level. The four layers are the whole topology.

### The subsystems and what each owns

**The kernel** (`src/kernel`) is the two Cordis properties in the fewest mechanisms: a context tree where *registration context = visibility = lifetime*, typed service tokens, plugins with a declared dependency lifecycle, disposers run in reverse order, and typed events with an `observe` hook.

**Core** (`src/core`) is eighteen service contracts (*keys*), each a Definition with one provider — a core default driver or a capability — and consumers over it.

| Concern | Keys | Owns |
|---|---|---|
| Facts | `sessions`, `persistence` | the append-only session log and everything derived from it; the read contract for stored logs |
| Cognition | `llm`, `prompt`, `agents` (+ the `loop` driver, a plugin) | the provider-neutral model stream and adapters; stable prompt sections; the agent registry; the turn/step driver |
| Effects | `tools`, `fs`, `shell`, `jobs` | the guarded tool pipeline; the filesystem contract, with the write fence inside its provider; the policy-bound shell; owner-scoped background jobs |
| Authority | `sandbox`, `approval`, `authority-presets`, `credentials` | the current policy record and how it changes; approvals and their audit; named bundles of both; credentials by *name* only |
| Context | `compaction`, `spill`, `attachments` (+ metering, a pure fold with no key) | summarizing old history; oversized output; images; the one context-pressure number |
| Assembly | `settings`, `invariants` | user defaults a client may change; validation of every event before it enters the log |

ARCHITECTURE §3 also states what each key must *not* own — `sandbox` never owns an enforcement backend or a word of what the model is told, `tools` never owns policy — and those negative clauses are where most of the design lives.

**Capabilities** (`src/capabilities`) are providers and consumers over those seams: three model adapters, JSONL persistence, the filesystem with its fence, the shell with its confinement backends, the model-facing tools, compaction, spill, and the client protocol.

### The invariants that hold

- **The log is the only truth.** The model's history is a fold over three *model-visible* event kinds; everything else is a log-only fact or trace. New durable state is added as a new log-only event kind, never as a field a user interface holds.
- **Model-visible ⟺ logged.** Every model request is exactly what the log derives — the message history plus the request settings — and a runtime check verifies that before every call.
- **Durable before every action.** A sync to disk precedes every paid model call and every tool effect.
- **The model proposes, policy decides, the effect boundary enforces, the log records.** Enforcement lives at the effect, never at the tool gate.
- **A delegated child opens under a ceiling it cannot widen**; **the route is a fact**; **user interfaces render the log by the page and own only live, non-durable state** such as the current input and connection.
- **A repository may say how it likes its code and may not say what the harness is allowed to do.** There is deliberately no per-workspace configuration layer; composition and settings live only under `~/.minidsh`.

### Where a new thing goes

ARCHITECTURE §11 is a table from *new thing* to *home*: a model provider is an adapter under `capabilities/llm-<p>`, a model-facing capability a tool under `capabilities/tool-<x>`, an authority knob a log-only event with a fold, a capability that needs no code edit a row in `composition.json`.

## What MiniDSH learned from DeepSeek Harness

DSH is a large, fast-moving system (363 packages by its [module graph](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/module-graph.md) on 2026-10-23); [`references/`](references/README.md) is this project's pinned map of it, and ARCHITECTURE §12 the reason for each difference below.

### Ideas taken

- **Capabilities have lifecycle and dependency semantics.** Plugins depend on Service Definitions, never concrete providers ([packages/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)).
- **Each agent gets its own registration scope**, disposed when the agent ends ([note of 2026-07-08](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md)).
- **A tiny model-facing tool surface is enough.** DSH's `minimal` preset ([minimal.patch.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/presets/minimal.patch.yml)) is a persona and one persistent shell (since 2026-10-12 plus image reading and compaction); MiniDSH's default is `bash`/`pwsh`, `str_replace_editor` and `subagent`, plus three job tools and, where a browser is installed, five browser tools.
- **The session log is the record; the model-visible history is derived from it** ([session](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md), [compaction](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md)).
- **Bytes beside the log, references in it** ([attachment seam](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md)).
- **Confinement is a spawn wrapper inside the shell provider** ([sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md), [sandbox-local](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)), its bubblewrap profile adopted flag for flag.
- **The wire is newline-delimited JSON-RPC, and the browser is a client, not a second agent** ([SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md), [web client note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)).

### Deliberately simplified

- **An own kernel instead of Cordis**: the two properties in five mechanisms and about nine hundred lines.
- **One package with a dependency gate instead of hundreds.**
- **Sequential, foreground, one child at a time:** no parallel tool calls, continuable children or agent teams; a background job belongs to its session, is closed `lost` if the process dies, and wakes it a bounded number of times (DSH: a lost job stays open, wakes unbounded).
- **One protocol over three transports** (stdio, in-process, WebSocket), not several composition profiles.
- **Two confinement backends, not four:** no Landlock (a native launcher) and no Windows backend (DSH's reports only partial enforcement).
- **A terminal client ships** (DSH removed its TUI in a note of 2026-08-04).
- **History recall appears only when needed:** `history_read` is hidden until the first compaction; DSH's `session-query` tools are opt-in for the schemas they add to every request.

### Where it diverges

- **The workspace root is the whole writable ceiling**, where DSH's `workspace-write` also grants the temporary directories and any extra roots an operator names.
- **Whether the host can confine is probed and recorded when the agent is created**, even for a sole backend, and "no backend" is an honestly reported state a session can accept on the record.
- **A delegated child's starting authority is an enforced ceiling**; **a consent is to the runtime's record of the call**, where DSH shows the model's prose; **a model role can route one kind of call away from the session's recorded route**; **an approval no connected client can answer is refused, not left hanging.**

### Not built

PTC (DSH's programmatic tool calling), model-written dynamic packages, an MCP client, session deletion and per-user identity: BLUEPRINT §2 lists them, and puts a desktop launcher on the route.

## The architecture-first experiment

Nearly all of the code was written by coding-agent *development sessions* under a short constitution ([`CLAUDE.md`](CLAUDE.md)) whose first rule is that **architecture defines sessions; sessions do not define architecture.**

**Every capability has a home before it has code.** A session states a capability's layer, seam, owned state and lifecycle before implementing it. When OS confinement arrived in the eleventh session the answer was "nowhere new": the shell contract had specified it since the third.

**Falsify the architecture, and repair it.** A hardening checkpoint follows each cluster of architectural change and finds the documented invariants that are not true in code. They found several — stated invariants that were not implemented, a crash-repair path that resumed conversations in a shape the providers' APIs reject, a network client that could inject a prompt into a running delegated child, a documented security claim an experiment disproved — and [`BLUEPRINT.md`](docs/BLUEPRINT.md) §4 records each with what it measured.

What it taught: documentation drift is a defect, so the documents carry size budgets a gate enforces; a convention that is not gated does not hold, so the dependency rules are scripts; verification means the world, not the agent's account of it. After seventeen sessions and two releases, a new contributor can still answer where a capability belongs, what each layer owns and where truth is stored, from one document.

## Verification

`pnpm check` is typecheck, lint, the dependency gate, the documentation gate and about 1,400 tests, run in CI on Ubuntu, macOS and Windows, each leg followed by an install smoke of the packed tarball. Tests mount real compositions with the model scripted or replayed from a recorded log, and two real logs, one from `minidsh@1.0.0`, are repaired and replayed in every run.

Twelve live end-to-end tests — *arcs* — run against real providers before a release, in a workflow the release waits for (Linux, macOS) and by hand (Windows, Linux). Each asserts the world where one exists: a task killed inside a tool call is repaired by a second process and its log replays without a key; an edit outside the workspace is refused and the file absent; a context-budget crossing compacts and spills; a session switches provider mid-conversation; a delegated child's escalation is refused by its pin; the web client shares a session between two clients and takes a consent over the wire; a job's end wakes an idle agent; a skill turns a PDF and a CSV into a Word report; the browser sees a runtime bug before the edit that fixes it. The macOS leg, under Seatbelt, is the only evidence this project has for that platform.

## Documents and help

| | |
|---|---|
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | the contract: layers, ownership, the log, authority, user interfaces, where new things go, limitations |
| [`PROJECT.md`](docs/PROJECT.md) | the thesis, positioning and research context |
| [`BLUEPRINT.md`](docs/BLUEPRINT.md) | what comes next, the open questions, and the per-session development record |
| [`CLAUDE.md`](CLAUDE.md) | the working constitution the building sessions run under |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md) | how to contribute, where the security boundaries are, what changed |

**Getting help.** Bugs: the bug-report issue template. Design questions, or a capability with no line in the ARCHITECTURE §11 table: the architecture-question template. Vulnerabilities: privately, as [`SECURITY.md`](SECURITY.md) describes.

## License and attribution

MIT — see [`LICENSE`](LICENSE). MiniDSH is an independent educational and engineering project inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek). It is not an official DeepSeek project and is not affiliated with or endorsed by DeepSeek. The code is implemented independently; where a contract, profile or wording is adapted, the source is credited in the adjacent comment and summarised in [`NOTICE`](NOTICE).
