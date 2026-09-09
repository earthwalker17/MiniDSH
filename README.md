# MiniDSH

[![npm](https://img.shields.io/npm/v/minidsh)](https://www.npmjs.com/package/minidsh)
[![check](https://github.com/earthwalker17/MiniDSH/actions/workflows/check.yml/badge.svg)](https://github.com/earthwalker17/MiniDSH/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node ≥ 24](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)

> **Minimal surface. Complete architecture.**

MiniDSH is a small, local-first coding-agent harness — the runtime around a model that gives it tools, sessions and permissions — that you can install, point at a repository, and use from a terminal, a browser or a script. It is also a reference architecture: a codebase small enough to read in a sitting, with the boundaries of a modern agent harness drawn explicitly. And it is an experiment in growing an AI-assisted system *architecture-first* rather than feature by feature.

It studies [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — DeepSeek's open-source coding agent, built as a composition of plugins and unusually well documented — as a textbook, and asks how small a system can be while keeping the same architectural properties. It is an independent educational and engineering project. It is not a fork, not a product, and not affiliated with or endorsed by DeepSeek.

---

**Contents:** [What it is](#what-minidsh-is) · [Quick start](#quick-start) · [What you get](#what-you-get) · [Status and limitations](#status-and-limitations) · [The question it investigates](#the-question-it-investigates) · [Architecture](#architecture) · [What it learned from DeepSeek Harness](#what-minidsh-learned-from-deepseek-harness) · [The architecture-first experiment](#the-architecture-first-experiment) · [Verification](#verification) · [Documents and help](#documents-and-help) · [License](#license-and-attribution)

---

## What MiniDSH is

Three things, in this order of ambition:

1. **Useful software.** A coding agent that edits files and runs commands under an authority you set and can audit afterwards; that survives its own process and can be resumed or forked from its log; that manages its own context; that can delegate a bounded task to a child, or a visual check to a model that can see. Two providers ship (DeepSeek and Anthropic), and a session can change which model it talks to mid-conversation.
2. **A reference architecture.** About twenty thousand lines of TypeScript in one package with one runtime dependency, organised into four layers with a dependency rule a gate enforces, seventeen service contracts in core plus one in the application, each with stated ownership, twenty-seven durable event kinds, and one document — [`ARCHITECTURE.md`](ARCHITECTURE.md) — that says where every new thing goes. The properties it keeps: an append-only session log as the only truth; capabilities composed over a tiny kernel with lifecycle and dependency semantics; authority separated from model reasoning and enforced where the effect happens; the model as a capability the runtime routes to, not the agent itself; and one runtime behind every user interface.
3. **A systems-engineering experiment.** Whether a project built almost entirely by coding-agent sessions can keep a global architecture intact across months, by making the architecture explicit, inspectable and continuously falsified — rather than letting sessions gradually invent it. The record of that experiment is part of the repository.

The thesis is **fewer concepts and stronger invariants** rather than fewer lines or more features. DeepSeek Harness is the reference because its architecture is explicit about the same questions; the point was never to reproduce it, compete with it, or prune it, but to learn what it knows and find out how small a system can be while still knowing it.

## Quick start

Requirements:

- **Node 24** or newer.
- **Windows:** PowerShell 7 (`pwsh`). The shell tool refuses to run under PowerShell 5.1 rather than pretending. Windows has no shell-confinement backend, so every shell command there costs one approval (below).
- **Linux:** `bubblewrap` (`apt install bubblewrap`) if you want shell commands confined by the operating system instead of approved one by one. **macOS** needs nothing extra.
- **A provider key:** `DEEPSEEK_API_KEY` for the default route, `ANTHROPIC_API_KEY` for the Anthropic one — in the environment, or in `~/.minidsh/credentials.json` as `{"DEEPSEEK_API_KEY": "…"}`. Only the *name* of a key is ever logged; a run without one stops and names the key it expected.

```sh
npm install -g minidsh            # or run it without installing: npx minidsh …

minidsh chat --cwd path/to/repo   # interactive terminal (--cwd defaults to the current directory)
minidsh web  --cwd path/to/repo   # the same runtime in a browser; open the one URL it prints
minidsh run "fix the failing test in src/slug.test.mjs" --approve
                                  # --approve answers every approval yes; without it a headless run
                                  # refuses anything that needs one — on Windows, that is every shell command
minidsh run "review this module for unchecked inputs" --provider anthropic --model claude-sonnet-5
minidsh run "summarize this repository" --json     # one JSON line per session event on stdout

minidsh sessions list                     # what is stored, by name
minidsh sessions show <id> --audit        # what this session was allowed to do, and when
minidsh resume <id> "continue"            # pick a stored session up; fork <id> --at <seq> branches it
minidsh config                            # the effective plugin composition, with per-row provenance
minidsh --help
```

In the terminal: `y`/`N` answers an approval; `/sandbox <mode>`, `/ask <ask|never>` and `/preset <name>` switch authority; `/model [<provider>/]<model> [effort]` switches the model; `/compact` shrinks context; `/history` pages back; `/sessions` lists what is stored; `/cancel` stops the running turn; `/exit` quits. Typed input while a turn is running steers it.

Everything MiniDSH keeps lives under `~/.minidsh` (override with `MINIDSH_HOME`): `sessions/` (one JSONL log per session), `spill/` (oversized tool output, swept after 30 days), `attachments/` (content-addressed images, never swept), `composition.json` (yours), `settings.json` (yours, and the one file the runtime also writes, through the settings method on the wire), `credentials.json` (yours), and an optional `AGENTS.md` that every session reads. A session is stored the moment it records its first prompt, so a `chat` opened and closed leaves nothing behind. Nothing in the harness deletes a log.

From a checkout, `pnpm install` then `pnpm minidsh …`: TypeScript runs natively on Node 24, so there is no build step in development, and `pnpm check` runs the whole gate. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Before relying on it, read [Status and limitations](#status-and-limitations) — in particular the Windows and network lines.

## What you get

Each item below is the visible consequence of an architectural decision, which is why each says where the behaviour comes from.

**Authority you set, and a record you can read back.** A run defaults to `workspace-write` with approvals `ask`: file modifications are fenced to the working directory, reads are unrestricted, and shell commands are confined by the operating system where one can — bubblewrap on Linux, Seatbelt on macOS — chosen automatically and *probed* before the harness claims it, because a sandbox that is installed and cannot enforce is the case that matters. On a confined host an ordinary task costs nobody a decision, and a command that writes outside the workspace fails because the OS refused it. On Windows nothing can confine a command, so every shell command costs one approval: the harness refuses to run it confined, the model asks for a one-shot escalation, and a person grants it — in the terminal, in the browser, or with `--approve` on a headless run. `danger-full-access` drops confinement for the whole session, and the first approval prompt says so. Every session opens by recording the mode and the approval policy it starts under, and every switch, request and decision is an event in its log: `sessions show --audit` prints that history back. Confinement governs **file effects only** — a confined command still reaches the network and inherits the environment MiniDSH was started with, keys included.

**Sessions that survive their process.** Everything the model was shown and everything it did is one append-only JSONL log. Kill the process mid-turn and the next `resume` repairs the tail, closes the interrupted turn, and continues under the authority the log recorded. `fork <id> --at <seq>` branches an ordinary session at any point in its log. A second process cannot resume the same session — a lease refuses it before a byte is appended. Because the model's history is derived from the log rather than kept beside it, a stored log replays keylessly as a test of the session that wrote it.

**Context that manages itself, without losing anything.** A meter over the log tracks pressure (the terminal shows `[ctx 34% · 12.4k/32k]`); when the projected request nears the model's window, the oldest history is *replaced* by a summary while the events it shadowed stay in the log, and from then on the model can read a range of them back with `history_read` under a budget — so a fact the summary dropped is recoverable rather than gone. Tool output too large to show inline is spilled to disk with a head/tail excerpt and a path. An `AGENTS.md` (or `CLAUDE.md`) in the workspace enters as context: instructions to the model, never permissions for the harness.

**The model as a capability the runtime routes to.** The *route* — provider, model, reasoning effort — is a durable fact a session can change mid-conversation (`--provider`/`--model`, `/model anthropic/claude-sonnet-5`, or `session/model` over the wire). The log records the base route, the effective route and each model's real context window, so a switch is visible, meterable and replayable, and every assistant message says which model wrote it. A `model-roles` entry in the composition maps a *purpose* to a route — the compaction summary on a cheap model, a delegated child on another — without touching what the conversation runs on. The DeepSeek adapter ships `deepseek-v4-flash` (MiniDSH's default), `deepseek-v4-pro` and a vision model; the Anthropic adapter ships the Claude 5 and 4 families with per-model facts (window, output cap, effort set, whether a temperature is accepted) measured against the live API. An option a provider cannot honour is refused before any I/O, never silently dropped.

**Delegation with a ceiling.** The model can hand one bounded task to a `subagent`: a child with its own session and log, whose authority is fixed at its parent's or narrower the moment it starts and cannot be widened from inside — approvals are off, so an action needing one is refused rather than escalated. A verifier that can *see* is the same tool mounted a second time on a vision route (`view_image` ships as a plugin you insert). `sessions list` marks a child with its parent; its log stays.

**Composition from disk.** What MiniDSH *is* is data: thirty-five built-in plugin *rows* (a row is one entry in the composition — a plugin and its config), layered by `~/.minidsh/composition.json` and `--patch` files, with per-row provenance. A row can be disabled, reconfigured, or inserted by module specifier; a row with a key its plugin does not know fails boot naming the row; and every session stamps the composition it ran under, so a resume under a different one is a recorded fact. `minidsh config` shows the effective result and flags any authority-sensitive row a layer changed.

**One runtime, three ways in.** The headless CLI, the terminal and the browser are three clients of one runtime speaking one newline-delimited JSON-RPC protocol (`minidsh serve` exposes it on stdio for your own client). The terminal and the browser hold no semantics of their own: they render the log by the page and drive the agent registry. Several clients can watch one session; a browser tab closing ends nothing.

## Status and limitations

**Version 1.0.0** is the smallest release a developer can install, point at a repository and use daily without reading the architecture. It is a small project with one maintainer, and it is honest about its edges. The full register is ARCHITECTURE §13; the ones most likely to matter first:

- Windows has no shell-confinement backend and is not getting one. Every shell command there costs an approval, and a headless run without `--approve` cannot run a shell at all.
- Confinement governs file effects only. A confined command reaches the network and reads the harness's environment, provider keys included.
- The filesystem fence follows symbolic links and cannot follow a hard link; on a confined host the shell is unaffected because the OS bounds the whole process.
- Tool execution is sequential and a delegated child is foreground; there are no background jobs.
- No session deletion, search or rename; no OpenAI adapter; composition changes need a restart; an out-of-tree plugin loaded from an installed package owns its own `package.json` and dependencies.

What comes next is decided by the open questions in BLUEPRINT §3 rather than by a feature list.

## The question it investigates

A common way to build software with AI coding agents is to define a product, invent a sequence of features, hand one cluster to each session, and repeat. It works, in the sense that each session ships something that passes its tests. What it produces over months is *architectural accretion*: features acquire local homes rather than principled ones, ownership blurs, state crosses boundaries because sharing a mutable object was convenient, UI concerns leak into runtime semantics, and every later session must rediscover why the system looks the way it does. The repository can look feature-complete while being structurally weak. [`PROJECT.md`](PROJECT.md) describes the failure mode in more detail; it is the reason this project exists.

DeepSeek Harness is interesting here because its answer to the same pressure is unusually explicit. It describes itself as an *everything-is-a-plugin* harness built on [Cordis](https://github.com/cordiverse/cordis), whose paper, [*A Programming Paradigm for Spatiotemporal Composability*](https://github.com/cordiverse/paper), names the two properties that make dynamic composition sound: *temporal composability*, "the ability to completely revert a component's side effects upon removal", and *spatial composability*, "the ability to declare and reactively manage inter-component dependencies". Its architecture document puts the consequence plainly: "There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads."

That framing is the textbook. The question MiniDSH asks of it is:

> **What is the minimum modern agent harness that still preserves the architectural properties required for long-term composition, observability, verification, multi-surface evolution and maintainability?**

"Minimum" is measured in concepts, not lines: how many ideas a contributor must hold; how many modules a new capability touches; whether state ownership is stated; whether execution can be understood from canonical events rather than reconstructed from a UI; how much of the model-facing surface a feature costs; how easily a provider, a tool or a user interface can be replaced or removed. DeepSeek Harness's own `minimal` preset already minimises what the *model* sees; MiniDSH asks how far the *whole system* can be simplified.

The working rule that came out of it is **everything evolvable has a seam** — and, as importantly, not everything is evolvable. A *seam* is a first-class composition boundary: a contract one side defines and another side provides. A capability earns one when it may realistically need to be replaced, isolated, scoped, enabled or disabled, supplied by another implementation, or owned by a different lifecycle. A pure helper, an algorithm or a type does not, and turning it into a plugin for consistency is a cost with no return. Where dynamic composition should *stop* is the project's central research question, and the answer is concrete: a kernel with five mechanisms, eighteen seams, and everything else ordinary code.

## Architecture

This is a reading guide. [`ARCHITECTURE.md`](ARCHITECTURE.md) is the contract — what each layer owns, what it may not own, the invariants, the divergences from DeepSeek Harness and the known limitations — and its section numbers are cited from code comments. Two words to hold while reading: a **fold** is a pure derivation over the session log (the model's history, the current authority, the context pressure are all folds), and a session's **opening stamp** is the set of events it records at creation, before it is announced to anyone — the authority it starts under, the composition it runs in.

### Layers and the dependency rule

```
src/app/            application assembly and user interfaces: the composition (rows, patches, catalog),
                    disk config, the headless CLI, the terminal client, the browser host + client,
                    the stdio protocol host, the one event→line projection
src/capabilities/   providers and consumers over core seams — never import each other, never app
src/core/           the spine: the service contracts (Service Definitions) and their default drivers as plugins
src/kernel/         composition substrate: Context, plugin lifecycle, services, effects, events
src/test-support/   scripted adapter, replay-from-log adapter, composition harness
```

| from | may import |
|---|---|
| `kernel` | nothing internal |
| `core/<x>` | `kernel`, other `core` contracts — except `core/loop`, which only `app` imports |
| `capabilities/<x>` | `kernel`, `core` Definitions only; a provider never imports another provider or a consumer |
| `app` | anything |

Three rules are enforced by a script in `pnpm check`, not by convention: the table above; that an event payload is read through `matches(event, KIND)` and never cast; and that `core` is acyclic at file level — its packages may depend on each other in both directions (agent ↔ sandbox, session ↔ llm), which stays sound because each package keeps its type vocabulary in a file below its service, so no file's imports ever close a loop. A deeper tree is not more architecture: the four layers are the whole topology, and a capability is a directory, not a package.

### The subsystems and what each owns

**The kernel** (`src/kernel`, about nine hundred lines) is the two Cordis properties with the smallest mechanism set that supports them, and no loader, hot reload, isolate, proxy or mixin. A **Context** is a non-mutating tree; registrations made through a context are attributed to it and unwound with it, so *registration context = visibility = lifetime*. **Services** are typed tokens claimed once per context chain; a plugin's `get` is strict — only keys it declared or provided. **Plugins** are `{ name, inject?, config?, apply }`: pending until every injected key is provided, unloaded when one vanishes, reloaded when one is replaced, with config parsed before `apply` so a malformed row fails loudly naming the plugin. **Effects** push disposers that run in strict reverse order. **Events** are typed tokens that carry their dispatch mode (`emit`, `waterfall`, `serial`, `parallel`) so the wrong method is a compile error; an `observe` hook sees every dispatch before any listener, which is where runtime invariants hang.

**Core** (`src/core`) is seventeen service keys — each a *Definition*: a contract one capability provides and others consume — plus the vocabulary they share; the eighteenth key, the composition handle, is the application's. Grouped by concern:

| Concern | Keys | Owns |
|---|---|---|
| Facts | `sessions`, `persistence` | the append-only log, its three tiers, the folds that derive everything else; the read contract for stored logs |
| Cognition | `llm`, `prompt`, `agents` (+ the `loop` driver, a plugin) | the provider-neutral stream vocabulary and adapter registry; stable prompt sections; the agent registry (create/resume/fork as a transaction); the turn/step driver |
| Effects | `tools`, `fs`, `shell` | the guarded execution pipeline and its deadlines; the filesystem contract, with the fence inside its provider; the policy-bound shell session |
| Authority | `sandbox`, `approval`, `presets`, `credentials` | the one policy stamp and its folds; the approval seam and its audit pair; named bundles of both; credentials by *name* only |
| Context | `compaction`, `spill`, `attachments` (+ metering, a pure fold with no key) | the compaction bracket and the pure planner; oversized output; the binary plane; the one pressure number |
| Assembly | `settings`, `invariants` | user defaults a wire client may change; pre-commit validation of the log |

The table in ARCHITECTURE §3 states for each key what it owns *and what it must not own* — `sessions` never owns a persistence backend, the model or UI state; `sandbox` never owns an enforcement backend or a word of what the model is told; `tools` never owns policy. Those negative clauses are where most of the design lives.

**Capabilities** (`src/capabilities`, twenty-five directories) are providers and consumers over those seams and nothing else: two model adapters (`llm-deepseek`, `llm-anthropic`), the JSONL persistence with its write lease, the local filesystem with the fence, the shell provider with its confinement backends, the model-facing tools (`bash`/`pwsh`, `str_replace_editor`, `subagent`, `history_read`, `view_image`), compaction, spill, workspace instructions, the client protocol, and the small plugins that turn recorded facts into model-facing prose. A capability that needs another's *kind* of tool recognises it by a tag, never by name.

**The application** (`src/app`) is assembly and user interfaces: the default composition as thirty-five typed rows, disk layers, the CLI's flag table, the terminal client, and the browser host with a plain-JS client that shares no code with it. A user interface — the code calls them *surfaces* — injects the agent and session registries plus the model catalog and the authority pair, owns transport and process exit, renders from the event stream, and holds no authority state: a switch it asks for becomes a durable event it reads back like any other.

### The boundaries and invariants that hold

The system is defined by a short list of statements that are true everywhere and tested; several are also enforced at runtime, in live sessions as well as in tests.

- **The log is the only truth.** Every event is `{type, seq, time, data}`, `seq === log.length`, frozen at append. The model's history is a fold over three *model-visible* kinds; everything else is a log-only *fact* the runtime folds, or *trace* recorded for replay and never folded. A plugin that needs durable state adds a log-only kind, never a field a user interface holds.
- **Model-visible ⟺ logged.** Every request the loop sends equals the derived messages plus the folded request header; a runtime invariant rebuilds both before the stream and fails on any divergence. Consecutive requests extend their predecessors, which is what provider prefix caches reward.
- **Durable before every action.** A flush precedes every paid model call and every tool effect; a lost write ends the turn with every remaining call answered and none run.
- **The model proposes, policy decides, the effect boundary enforces, the log records.** One authority stamp, resolved per call, never assembled by a caller. Enforcement lives at the effect — the fence inside the filesystem provider, the OS backend around the shell — not at the tool gate, so no tool is the boundary and none needs to know about one. What a host can actually enforce is probed and recorded when the session opens, before any command runs.
- **Every decision is a fact.** The opening mode and policy, every switch, every approval asked and decided, every escalation; a resumed session keeps what it recorded rather than inheriting the deployment default.
- **A delegated child opens under a ceiling it cannot widen**, held three ways: approvals pinned, setters refusing, and an invariant rejecting a widening stamp before it enters the log.
- **The route is a fact.** The base route is a durable knob separate from the effective route; the route is resolved once per step and fixed for every retry of it.
- **Refuse at admission; substitute at projection.** An image is refused before any I/O when the current model cannot take one, and a text-only model is sent the stored description of an image that is already in the history — because durable history outlives the model that first consumed it.
- **Registration context = visibility = lifetime.** An agent's tools, guards, prompt sections and services live in its scope and die with it; a scope cannot reach a deployment-global registry.
- **User interfaces render the log and own only the live control plane.** A client is handed a message-aligned page of the log, never a whole session, plus the few numbers one page cannot derive (pressure, open approvals, authority, route); no client rebuilds the model's history.
- **A repository may say how it likes its code and may not say what the harness is allowed to do.** There is deliberately no workspace-level configuration layer.

### A turn

```
followup(m) → next turn      steer(m) → next step (wakes)      inject(m) → next step (no wake)
turn/start
  claim inbox → resolve route (request/context when changed) → agent/pre-step (reject | enter)
  step/start → user/message per entered message → prompt.assemble (request/header when changed)
  CHECKPOINT → llm.stream → assistant/chunk* → assistant/message{usage}
       finish error ⇒ agent/request-error → retry (same request) | turn/end{error}
  tool calls in model order: tool/call → CHECKPOINT → tools.execute → tool/result
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

Tool execution, every event in the acting agent's scope: validate → `tools/pre-execute` (`allow | deny | ask`) → deny-only guards → `ask` → the approval seam → deadline armed → around-middleware → body → validate and freeze → render → `tools/post-execute` → normalized result. Guards run before the ask, so a call they would refuse anyway never interrupts a person. Only `{name, description, parameters}` of a tool ever reaches the model.

### Where a new thing goes

ARCHITECTURE §11 is a table from *new thing* to *home*, and it is the artifact that makes architecture-first operational: a change with no row is an architecture question to settle before it is an implementation task. A sample:

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: register an adapter; refuse before I/O what the wire cannot honour |
| a model-facing capability | `capabilities/tool-<x>`: register on `tools`, plus a prompt guidance section |
| an authority knob | a log-only event with a fold, an opening stamp, and a setter that *is* the event — never a field a user interface holds |
| durable state | a new session event kind, rendered and replayed from the log |
| a user interface | consume the event stream, drive the agent registry; zero semantics |
| a capability without a code edit | a row in `composition.json` |

## What MiniDSH learned from DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) is a large, fast-moving system — 267 packages in 50 groups as of 2026-09-09 by its own [module graph](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/module-graph.md), up from 167 in July — with an unusually good written architecture: an [architecture document](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), [one page per subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/README.md), a [package hierarchy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md), and [dated notes](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/notes) recording why each boundary exists. MiniDSH read it the way one reads a textbook: by question, tracing each through those layers to the code and its tests, and reproducing principles rather than implementations. Where a contract, a profile or wording is adapted, the adjacent comment says so ([`NOTICE`](NOTICE)). DSH's paths and notes move — several links that were current a month ago are archived today — so the links below were checked on 2026-09-09 and should be read with that date in mind.

### Ideas taken

- **Capabilities have lifecycle and dependency semantics.** The two Cordis properties — effects that unwind on removal, dependencies that are declared and reacted to — are the kernel's whole reason to exist. DSH's rule that "extension plugins depend on Service Definitions, never concrete providers" ([packages/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)) became MiniDSH's three-role seam: a Definition in core, a Provider and a Consumer in capabilities, and a seam that is complete only with all three.
- **The agent is a registration scope.** DSH's note of that title ([2026-07-08](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md)) — "every live agent owns one flat registration layer exposed as `agent.ctx`", disposed with the agent — is the shape of MiniDSH's scope contract, flat scopes included.
- **A tiny model-facing tool surface is enough.** DSH's `minimal` preset ([agent.cordis.yml](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-presets/presets/minimal/agent.cordis.yml)) mounts a persona and a single persistent shell and nothing else (it paired the shell with a structured editor until September 2026). MiniDSH's default is three tools — a persistent shell, a structured editor and one-shot delegation — with recall hidden until a compaction makes it answerable, and a vision tool that is a row you insert.
- **The session log is the record, and the model-visible history is derived from it.** DSH's [session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md) is where the split between message-producing events and log-only events comes from, and the idea of replacing a range without rewriting history. MiniDSH's compaction triggers — pressure, canonical overflow, explicit — follow DSH's [compaction subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md).
- **Bytes beside the log, references in it.** DSH's [attachment seam](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md) publishes "an immutable content-addressed reference only after the object is durable", and session events carry "that reference and metadata, never a browser object URL, host temporary path, provider URL, or base64 payload". MiniDSH's attachment plane keeps exactly that contract and adds one: the text description a text-only model is sent is computed once and stored, so a later change of wording cannot rewrite what an old log says the model saw.
- **Confinement is a spawn wrapper inside the shell provider, probed before it is claimed.** DSH's [sandbox subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md) supplies "Linux bwrap/Landlock, macOS Seatbelt, and the Windows ACL restricted-token backend", and its [sandbox-local package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md) reports `partial` for a backend that governs only a subset of the promised file effects. MiniDSH adopted the bubblewrap profile flag for flag and the functional probe, and records what the probe answered as `enforcement` on every session's opening stamp.
- **A provider-neutral LLM seam with a direct DeepSeek adapter.** DSH's [llm family](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/README.md) is "one provider-neutral service through which any composition streams requests", with a direct HTTP/SSE DeepSeek adapter beside a library-backed multi-provider one. MiniDSH's two adapters are both direct, and share one stream vocabulary and one validator.
- **The wire is newline-delimited JSON-RPC, and the browser is a client, not a second agent.** DSH's [SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md) "accepts SDK requests over stdio" as "newline-delimited JSON-RPC"; its web GUI is a host half and a browser half in separate package groups, the browser running "a second, client-side cordis tree" ([web client note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md)). MiniDSH's protocol has that shape, and its rule that transport and presentation must not own harness semantics is the invariant behind "one runtime, three ways in".
- **Write down why.** DSH's `.agents/notes` — proposed, implemented, archived, rejected — is the practice behind MiniDSH's [`BLUEPRINT.md`](BLUEPRINT.md) §4, a per-session record of what was decided and what was measured.

### Deliberately simplified

These are not gaps; they are the experiment. Each is stated in ARCHITECTURE §12 with the reasoning that still shapes decisions.

- **An own kernel instead of Cordis.** DSH vendors Cordis; MiniDSH implements the two properties in about nine hundred lines with five mechanisms and no loader, hot reload, isolate realm, proxy or mixin, and a structural `{parse}` config contract per plugin instead of a schema library in the kernel. Registries take the owner context explicitly. The question was whether the properties survive without the framework, and they do.
- **One package with a dependency gate instead of hundreds.** A capability is a directory; the layers are enforced by a script rather than by package boundaries. Nothing here needs to be published separately, so nothing is.
- **Sequential, foreground, one child at a time.** No background jobs, no parallel tool calls, no continuable children, no agent teams. DSH's own `minimal` preset ships no jobs, delegation or teams either; the shapes are transferable if a real need arrives, and BLUEPRINT §3 names them.
- **One protocol on three carriers.** DSH ships web, headless, sdk, sdk-minimal and acp profiles; MiniDSH ships one JSON-RPC method table (sixteen methods) that a stdio carrier, an in-process pair and a WebSocket all serve, adding `session/cancel`, `approval/answer` keyed by the durable approval id, `session/authority` and a catalog-returning `initialize`.
- **Two confinement backends, not four.** Bubblewrap and Seatbelt. No Landlock — DSH's is supplied through a native addon, which a zero-native-dependency package with no build step cannot carry — and no Windows backend, because DSH's reports `partial` by construction: the restricted token must keep `Everyone`, and NTFS hard links alias one file object across paths. On Windows every shell command asks instead, and this README says so rather than the harness pretending.
- **A terminal client ships.** DSH removed its TUI (a simplification note of 2026-08-04); MiniDSH keeps one because a client over an in-process carrier is the cheapest proof that the wire carries everything a user interface needs.
- **Recall is gated, not opt-in.** DSH's [session-query](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/tool-session-query/README.md) is "opt-in" and "enabling it adds fixed guidance plus five tool schemas to every model request"; MiniDSH ships one tool restricted to what *this* session's compactions shadowed, hidden until the first one, so a session that never compacts never carries the schema.
- **JSON, not YAML; two disk layers, not four; read at boot, not watched.** And plain JSONL through one held descriptor, with a session-lifetime write lease.

### Where it diverges

Places where MiniDSH looked at DSH's answer and chose differently. These are MiniDSH's readings of DSH's documentation at the time each decision was made, and DSH moves quickly; ARCHITECTURE §12 carries them with their reasons.

- **The workspace root is the whole writable ceiling.** DSH's `workspace-write` "adds an ephemeral `/tmp` and a writable workspace bind" ([sandbox-local](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)). MiniDSH's `writableRoots` grants the workspace only and binds *both* enforcement families to the same list — because every "outside" fixture in its own tests is a sibling under the temp root, and granting it would dissolve the distinction the tests exist to prove. A plan item that said otherwise was reversed on that evidence.
- **`enforcement` is recorded at agent creation, and `none` is a supported posture.** MiniDSH probes the platform's one candidate backend before any command exists, so a stored log always states what its host could enforce, and a host with no backend is a documented configuration rather than an error.
- **A delegation's opening stamp is an enforced ceiling**, held by the setters, the escalation path and a pre-commit invariant, rather than by the pinned approval policy alone. `subagent/start|end` live in the parent's log rather than as runtime events.
- **The base route is a durable knob separate from the effective route**, and model roles are a seam. A purpose (a summary, a child, a verifier) may take a different route; the conversation's own route never moves under it.
- **A per-boot `composition/applied` record in every session**, because a resumed session should be able to say whether it is running under the composition that wrote it.
- **Approvals settle `unavailable` when nobody is left who can see them.** MiniDSH recomputes who could answer after every change in what clients are watching, and fails closed rather than leaving a question pending forever.
- **A confined child is put in its own POSIX session on both backends.** Seatbelt cannot make a new session, so a `detached` spawn — `setsid`, which is bubblewrap's `--new-session` by another name — closes the controlling-terminal escape on macOS as well as Linux.

### Not built

Background jobs and parallel tool calls; PTC (DSH's programmatic tool calling, formerly Code Mode); model-written dynamic packages (DSH's `extensions` family, which ships in its opt-in `cordis` preset); an MCP client; a Windows confinement backend and Landlock; standing approval grants; session deletion; a session search index; per-user identity; a desktop shell. Each is in BLUEPRINT §2 with the reason it is out of scope for V1. The workspace-level configuration layer is a different kind of absence — a deliberate one, stated in ARCHITECTURE §9.

## The architecture-first experiment

The second thing this repository is about is how it was built. Nearly all of the code was written by coding-agent *development sessions* — bounded working sessions of a coding agent under a human's direction, not to be confused with the MiniDSH sessions above — under a short constitution ([`CLAUDE.md`](CLAUDE.md)) whose first rule is that **architecture defines sessions; sessions do not define architecture.** The process, in three parts:

**Design the space before filling it.** The first development session began with the thesis, the layers, the dependency direction, the state-ownership answers, the session-log model, the authority boundary, the user-interface contract, and a dependency-ordered route of about a dozen sessions — and only then built the skeleton that made the architecture executable and testable: the kernel, the core spine, one adapter, persistence and a headless CLI. Every later session existed to advance the architecture along that route, not to add the next idea.

**Every capability has a home before it has code.** Before implementing anything meaningful, a session states its layer and owning subsystem, its seam, the state it owns and must not own, its dependency direction, its lifecycle and effects, and how it is persisted, observed, verified and removed. If a feature has no clear home, that is an architecture problem to solve first. The operational artifact is the *where new things go* table (ARCHITECTURE §11): when OS confinement arrived in the eleventh session, the answer was "nowhere new" — the shell contract had specified it since the third, so it became one strategy directory inside the shell provider and one knob on an already authority-sensitive row, with no new seam, service, event kind or configuration plane.

**Falsify the architecture, and repair it.** The architecture is a set of claims, and claims can be wrong. Every second feature session is followed by a hardening checkpoint whose job is to read the system as one architecture, probe it, and find the documented invariants that are not true in code. They found several. Three stated invariants in the foundation were not implemented. A crash-repair path resumed conversations in a shape the model providers' APIs reject. A network client could inject a prompt into a running delegated child, and the injected turn silently became the parent's tool result. And a documentation compaction *deleted* a stated limitation while leaving the claim above it absolute — reproduced in a few lines, restored, and now the reason the record says a document compaction needs a mechanical check by something other than its author. Research overturned plans too: a planned "extension authoring" session was dropped when DSH's own tree showed the feature ships only in its opt-in `cordis` preset. [`BLUEPRINT.md`](BLUEPRINT.md) §4 records each of these with what it measured.

Some things the experiment taught that were not obvious going in:

- **Documentation drift is a defect, not a chore.** Four documents are re-read at every session start, and each session ends by rewriting the architecture map to the actual implementation and deleting stale claims rather than accumulating history. When the four documents grew to about 230 KB, an architecture review called that a defect in its own right and compacted them — and the next review had to catch what the compaction lost.
- **A convention that is not gated does not hold.** Dependency direction, payload discipline and core acyclicity were conventions until a script pinned them — and the first version of that script had a hole that could have passed a real import cycle. A CI leg that exists to prove something may not go green having proved nothing, so a self-skipped confinement or shell test is a failure under the flag CI sets.
- **Verification means the world, not the agent's account of it.** Tests mount real compositions; only the model is scripted. A recorded session log replays keylessly as the oracle for the session that wrote it. End-to-end tests assert the file on disk and the test that now passes, and a live test whose premise is an assumption about the model decays silently — one was found measuring the provider's mood.
- **Delegation needs a fixed number.** A review that fanned out per finding reached forty-six agents before it was stopped, one session after the rule against exactly that was written. The rule that held is the one that makes the script state its agent count up front.
- **The first real CI run was red, honestly.** Two assertions compared a workspace root to itself and held only on the developer's machine. Provider catalogs rot silently (five live model ids matched no family prefix). Pipe behaviour is platform-specific (`--version | grep -q` crashed on macOS alone). None of these are architecture; all of them are why "green three times before the tag" is the release gate rather than "green once".

Whether the approach generalises is an open question. What the repository can show is that after sixteen development sessions and a release, a new session — or a new contributor — can still answer where a capability belongs, what each layer owns, where truth is stored, how effects are controlled and how a user interface talks to the runtime, and that the answers are in one document rather than in the heads of whoever wrote the last feature.

## Verification

`pnpm check` is typecheck, lint, the dependency gate and 676 tests, run on Ubuntu, macOS and Windows on every push to `main` or a release branch and on every pull request, followed on each platform by packing the tarball, installing it into an empty directory outside the checkout and starting the installed binary. Tests mount real compositions through the kernel; only the model is scripted or replayed from a recorded log. Three runtime invariants — the session's relational trace, agent status transitions, request reconstruction — run in live sessions as well as in tests.

Eight live end-to-end tests — the repository calls them *arcs* — run against the real providers before a release, from a manually dispatched workflow on Linux and macOS and by hand on both development hosts. Each asserts the world rather than the agent's report: a task completes, is killed mid-turn, is repaired and finished by a second process, and its log replays keylessly; an edit inside the workspace lands and one outside is refused and probed absent, then the shell branches on the enforcement the host reports; a from-disk composition inserts a module-loaded tool and the log proves it; a real context-budget crossing compacts and spills, and the log proves the shadowed range is recallable; a session switches provider mid-conversation and the mixed log replays from one script; a delegated child completes a bounded search with every approval refused and a wire attempt to widen it refused; a vision verifier reads an image the test drew while its parent is refused; and the browser signs in, shares a session between two clients, takes a real consent over the wire, pages a transcript to seq 0 and survives a socket killed mid-turn. The macOS leg runs under Seatbelt and is the only evidence this project has for that platform.

## Documents and help

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | the contract: layers, ownership, the log, the loop, authority, user interfaces, where new things go, divergences, limitations |
| [`PROJECT.md`](PROJECT.md) | the thesis, positioning and research context |
| [`BLUEPRINT.md`](BLUEPRINT.md) | what comes next, the open questions, and the per-session development record with its measurements |
| [`CLAUDE.md`](CLAUDE.md) | the working constitution the building sessions run under |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md) | how to contribute, where the security boundaries are, what changed |

**Getting help.** Bugs: open an issue with the bug-report template, which asks for the version, the platform and the enforcement the session recorded. Design questions, or a capability with no row in ARCHITECTURE §11: the architecture-question template — the discussion is the contribution. Vulnerabilities: privately, as [`SECURITY.md`](SECURITY.md) describes.

## License and attribution

MIT — see [`LICENSE`](LICENSE). MiniDSH is an independent educational and engineering project inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek). It is not an official DeepSeek project and is not affiliated with or endorsed by DeepSeek. The code is implemented independently; where a contract, profile or wording is adapted, the source is credited in the adjacent comment and summarised in [`NOTICE`](NOTICE).
