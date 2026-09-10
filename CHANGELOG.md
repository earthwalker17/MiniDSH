# Changelog

All notable changes to MiniDSH are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). The session-by-session engineering record, with what each session measured, lives in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) §4.

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
