# Changelog

All notable changes to MiniDSH are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). The session-by-session engineering record, with what each session measured, lives in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) §4.

## [Unreleased]

### Added

- **An approval says what the runtime will do, not what the model said about it.** The line a person answers now carries a *subject* the harness builds from the validated call arguments — the command, and the mode and enforcement it would run under — plus the whole call as the log recorded it, up to a bound past which the surfaces refuse the shortcut and point at `sessions show <id> --json` rather than hiding a command's tail. The model's justification sits beside that, never in place of it. Control characters in a subject are escaped rather than flattened, so two different commands can never render as one line.
- **A yes can outlive one call without outliving the session.** Where the host offers it, `a` in the terminal (or the browser's button) extends a one-shot approval to that exact action — same tool, same command, same authority — for the rest of the session. It is a durable event, it is offered by the runtime rather than invented by a surface, it dies the moment any authority knob moves, and `/grants` and `/revoke <id>` list and withdraw it. A near-miss asks again: this is not a policy language.
- **A session can accept the enforcement its host can actually deliver.** `--accept none` (or `/accept none`, or the browser's control, or `session/authority`) records that this session will run a shell command a host cannot confine — under its own sandbox mode, with the in-process file fence intact. On Windows, which has no confinement backend, that replaces paying a `danger-full-access` escalation per command, which used to drop the file fence as well. It is inert wherever a backend exists, it applies only to the mode it was given for, and a delegated child inherits it as a pin it cannot change.
- **Decisions record who made them**: policy, a standing consent (and which one), a person, or an automatic answerer. `sessions show --audit` and both clients print it.
- **An unattended run can approve exactly what a deployment declared.** `approval-headless` takes an `allow` list of exact subjects, answered `auto` — a middle rung between `--approve` (all of them) and the fail-closed default (none).
- **Crash repair closes every bracket the log left open** (from the durable-execution work that preceded this): an interrupted delegation, an interrupted compaction, and the tool calls of an interrupted step, with a durable fact recorded between a tool's approval gate and its body so repair can tell "never started" from "outcome unknown". Effects that land — file writes and shell commands — are recorded by the provider that caused them, after the fact.

### Security

- **A shell child no longer inherits this deployment's provider keys.** The harness builds the child's environment instead of passing its own through, withholding every credential name a provider row declared (including one a config file renamed), every secret-shaped name, and every `MINIDSH_*`. This is defence in depth, not a boundary: reads are still unfenced, so a credentials file remains readable, and a secret that is neither declared nor name-matching still passes.
- **A client can no longer answer an approval in a session it does not watch.** `approval/answer` now applies the same visibility rule that decides which connections are asked in the first place.

### Fixed

- **A detached session refuses appends.** After a session was detached, an append still succeeded in memory while persistence had already closed its file and dropped the event without an error: the log in memory and the log on disk could part ways silently. The store now closes the session before `session/disposed`, and a later append throws `SESSION_CLOSED`.
- **The browser shows every event the terminal shows.** The browser's event projection was an untested hand-copy of the terminal's and had drifted: a step's effective route (`request/context`) and a delegated child's route never appeared in the browser. The projection is now a typed, DOM-free module (`web/rows.js`) that a test holds to the terminal's visibility, kind by kind.

### Changed

- `docs/ARCHITECTURE.md` corrected in about twenty places where the code did not honour the text (what Windows really costs per shell command, what crash repair does not close, what a tool deadline does to its body, how the format version is stamped). `docs/BLUEPRINT.md` carries the post-1.0 route. `references/` is new: a curated, pinned map of DeepSeek Harness with a ledger of what MiniDSH assumes about it.

## [1.0.0] — 2026-09-09

The first public release: the smallest MiniDSH a developer can install, point at a repository and use daily without reading the architecture.

### Added

- **One runtime, three ways in.** `minidsh run` (headless), `minidsh chat` (terminal) and `minidsh web` (browser) over one runtime, plus `minidsh serve`, a JSON-RPC host on stdio. The terminal and the browser are protocol clients and hold no semantics of their own.
- **A kernel and a spine.** A small composition kernel — contexts, plugin lifecycle, typed services, effects that unwind, typed events with four dispatch modes — and eighteen service definitions over it. Everything the model can see and do is a plugin row; a boot composes thirty-five of them.
- **The session log as the only truth.** An append-only JSONL log with twenty-seven event kinds in three tiers; resume and fork from any stored log; crash repair that closes an interrupted turn; a single-writer lease; model-visible history that is, by a runtime invariant, exactly what the log derives.
- **Authority as a durable plane.** Sandbox modes, an approval policy and named presets, every switch and every decision an event; file writes fenced inside the filesystem provider; shell commands confined by bubblewrap on Linux and Seatbelt on macOS, each probed before it is claimed; a one-shot escalation path; delegated children that open under a ceiling they cannot widen; `sessions show --audit` to read the whole plane back.
- **Two providers, one vocabulary.** DeepSeek and Anthropic adapters over a provider-neutral stream, with signed-reasoning replay state, prefix-cache-stable requests, measured model catalogs, and options refused before any I/O rather than silently dropped. The route is a durable fact a session can change mid-conversation, and a `model-roles` row sends a purpose (a compaction summary, a delegated child, a vision verifier) down a different route.
- **Context management.** A pure meter over the log; compaction with three triggers, a durable bracket and a replacing surface operation that leaves history intact; bounded recall of what a compaction shadowed; spill for oversized tool output; workspace instructions from `AGENTS.md`.
- **Delegation and vision.** A `subagent` tool with its own session and log; a verifier that can see, as a second row of the same tool on a vision route; a content-addressed attachment plane.
- **Composition from disk.** `~/.minidsh/composition.json` layers over the built-ins with per-row provenance and a per-boot `composition/applied` stamp in every session; `settings.json` for user defaults; credentials by name only.
- **Verification.** 676 tests mounting real compositions, green on Ubuntu, macOS and Windows in CI with an install smoke on each; eight live end-to-end arcs against real providers, run from a manually dispatched workflow and on both development hosts before every release.

### Known limitations

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §13. The ones most likely to matter on day one: Windows has no shell confinement backend, so every shell command there costs one approval; confinement bounds file effects only, not the network or the environment; the filesystem fence cannot follow hard links.

[1.0.0]: https://github.com/earthwalker17/MiniDSH/releases/tag/v1.0.0
