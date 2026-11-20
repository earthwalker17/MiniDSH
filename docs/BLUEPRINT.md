# MiniDSH Blueprint

What comes next, the route there, what is undecided, and a compact record of how the system arrived. `ARCHITECTURE.md` (beside this file) is the current shape and its limitations; this file is direction and the measurements the architecture map does not carry. Its budget is in `scripts/check-docs.ts`; past 90%, compress §4 first (older entries collapse to what a later session reuses).

## 1. Next session — S22.5 Hardening checkpoint C = V2 release candidate

S22, S22.1 and S22.2 made the browser, the terminal and the desktop app product surfaces over one runtime. S22.5 reviews that cluster as one system and releases V2.0.0 (the npm package and the three installers) from CI.

- **The checkpoint.** A repo-wide read; invariants re-audited against code; current DSH re-researched and `references/` moved to one pin; the documents compacted where past 90%.
- **Owed by earlier sessions:**
  - Edge's cold start on the newer ubuntu image (S22.1: past 60 s once); diagnose it the S20 way before it fails every run.
  - The context arc's one keyless replay that consumed 7 of 8 summaries (S22); rerun it with the recording dumped on failure.
  - The desktop's CI legs and `release.yml`'s desktop job have never run on GitHub: their first run is this RC branch.
  - Electron 45.3.4 (chosen under pnpm's release-age policy) and the bundled Node 24.22.3 move to the newest of their lines.
- **Decisions it owes:** a signing identity (Windows: SignPath Foundation or Artifact Signing; macOS: Developer ID and notarization), and with it an updater (§3); an Intel macOS build.

**Gate.** Every arc 3× per host and `live.yml` unfiltered; the desktop E2E keyless on Windows and WSLg and live on the installed Windows app, 3× each; CI green on all three runners including the desktop legs; V2.0.0 published from a tag.

## 2. Macro route (dependency-ordered; sessions are approximate)

| Session | Architectural outcome | Depends on |
|---|---|---|
| ~~S1–S13, V1~~ | ✅ The kernel and the core spine; two adapters and three tools; JSONL persistence with resume and fork; the client protocol on three carriers; authority as a durable plane with two confinement backends; compaction and bounded recall; routing and delegation; the web surface; the attachment plane; `minidsh@1.0.0`; this route and `references/`. **§4 is the record.** | — |
| ~~**S14** Durable execution I (2026-09-20)~~ | ✅ Every unfinished bracket closed after a crash; a durable gate-to-body fact; an effect record; the delegating call on the child. §4. | S13 |
| ~~**S15** Authority II (2026-09-23)~~ | ✅ A trusted consent subject and the whole call on the line; who decided and under which consent; shell-enforcement ACCEPTANCE as its own knob; session-lifetime grants with revocation; the shell child's environment scrubbed. §4. | S14 |
| ~~**S15.1** Documentation reset (2026-09-24)~~ | ✅ The documents became maps sized to a reading load; references a navigation layer; compaction delegated. §4. | S15 |
| ~~**S16** Durable execution II (2026-09-26)~~ | ✅ The header as the one format mark; a per-lifecycle record of what its writer guaranteed; synced checkpoints; cold `sessions verify` and `inspect`; an audit of effects; salvage; an effect-free replay over two real fixtures. §4. | S14, S15 |
| ~~**S16.5** Hardening checkpoint A (2026-09-26 → 09-27)~~ | ✅ The record and authority planes reviewed as one system; `references/` at `477b4f42`; `minidsh@1.1.0` from CI. §4. | S14–S16 |
| ~~**S17** Jobs (2026-10-15)~~ | ✅ `core/jobs`: owner-scoped background work as a durable bracket; completion only through the inbox, waking bounded; the shell as the first producer; `job/cancel` and a control plane on the wire. §4. | S16.5 |
| ~~**S18** Providers and the first network tool (2026-10-16)~~ | ✅ `llm-openai` on the Responses API; measured catalogs held by drift probes; `tool-web-search` opt-in under per-query consent, never reaching a child. §4. | S15 |
| ~~**S19** Skills as data (2026-10-18)~~ | ✅ `capabilities/skills`: a skill list the model may use, one durable message read with ordinary tools; `office` and `pdf` as data on Node alone. §4. | S15 |
| ~~**S20** Browser verification (2026-10-19)~~ | ✅ `tool-browser`: our own CDP client, fenced inside Chrome to loopback and the workspace; image admission and process hygiene moved into core. §4. | S15, S17 |
| ~~**S20.5** Hardening checkpoint B (2026-10-25 → 10-26)~~ | ✅ The widened runtime reviewed as one system: one spawn home, bounded reads, a write judged by its handle, all-or-nothing authority switches, one grant rule, one provider wire, a two-job release; `references/` at `22ddee37`; 1.2.0 from CI. §4. | S17–S20 |
| ~~**S21** Multi-actor execution (2026-10-31)~~ | ✅ No scheduler: concurrency joined at the step; parallel foreground delegation, bounded by a durable per-agent width; replay keyed by delegation; an atomic editor CAS; jittered retry. §4. | S20.5 |
| ~~**S21.1** Continuations and process hygiene (2026-11-08)~~ | ✅ A child's narrowing as an opening fact every lifecycle re-applies; agent-owned work; a continuer's switches before any wake; every Windows pwsh contains what it starts. §4. | S21 |
| ~~**S22** Web UI redesign (2026-11-19)~~ | ✅ The browser as a product surface: tool presentation (`display`) on the wire, a conversation model joined by recorded ids, cards from durable facts, the view following status, a CSP with Trusted Types, the DOM under a real browser. §4. | S21.1 |
| ~~**S22.1** Terminal TUI redesign (2026-11-19)~~ | ✅ A full-screen terminal over the browser's presentation model (Codewhale as the reference): one controller for two views, consent at the keyboard, one neutralizing cell writer; `session/resume` and `session/fork` on the wire, the bypass deleted. §4. | S22 |
| ~~**S22.2** Desktop application (2026-11-20)~~ | ✅ An installable app over the same runtime and Web UI: an Electron launcher running the bundled CLI's `web --json` on a bundled Node; the token spent in main and the cookie injected per request; one serialized lifecycle confirming over the wire; folders as authority; NSIS, AppImage and zip from CI. §4. | S22 |
| **S22.5** Hardening checkpoint C = V2 release candidate | The product surfaces reviewed as one system; DSH refreshed; every arc and the desktop E2E 3× per host; V2.0.0 with its installers | S22–S22.2 |

**The ordering principle: deepen the record before widening the runtime.** Every later capability adds a new kind of effect or a new concurrent actor, and each must be expressible as log facts, under recorded authority, with a recovery rule, so those three come first. One concept runs through the first cluster: a core **effect vocabulary** (what a call is about to do and what it did, written by trusted code from validated arguments, never model prose) with three consumers: the crash record (S14), the consent subject and grants (S15), the audit of effects (S16). Authority precedes jobs because on Windows a background job cannot exist while every shell call is a one-shot escalation. **Checkpoints follow clusters of architectural change** (CLAUDE.md §6): the record and authority planes; the widened runtime; multi-actor and product.

**After S21: children stay foreground.** Background or continuable children wait for evidence that a parent must keep working, or be talked to, while its children run; their recorded home is §3. *Not:* agent teams, mailboxes, schedulers, swarm presets.

**Still refused, with the reason:** model-written extensions (upstream replaced its own with gated plugin installs; `node:vm` is no boundary); an MCP bridge (no demonstrated need); a Windows confinement backend (native bindings, standing ACL changes, `partial` today) and Landlock (a prebuilt native launcher); session deletion (no authority above the append-only seam, none upstream); PTC; a session search index; per-user identity; agent teams.

## 3. Open questions (a decision is pending; the limitations themselves live in ARCHITECTURE §13)

- **Detached children, when evidence asks.** The S21 panel recorded their home:
  - a `subagent` JobKind whose process is the child: `exited` is its run, `kill` its disposal, its output its answer;
  - one `jobs.quiesce` replacing the copied whenIdle → stopAll;
  - root-only;
  - a `job_ids` join on `job_output`.

  DSH left job-backed children over continuation (two FIFOs, two cancel authorities, one terminal fact against a multi-turn residency), not over one-shot children. The agent-owned-work primitive they need exists since S21.1 (`Agent.own`: lifetime-derived cancel, a bounded join, the end recorded before detach), with the idle `/compact` its only consumer; the driver, jobs, the host and tool-subagent still keep their own halves.
- **A second surface writer.** Only the compaction planner enforces "a replace never separates a call from its result", and the session invariant admits a `replace`-op `user/message` outside a step but not a `tool/result`. A pruner would be that second writer; the rule moves into the session when one exists.
- **Workspace-lifetime grants.** S15 shipped the session-lifetime shape and the identity any durable grant needs (tool plus exact subject), so what is left open is only the STORE. One that outlives a session cannot live in one log, `settings` may not own authority, and no workspace layer exists: a home-side store keyed by canonical root, COPIED into opening facts, is the only shape that keeps a stored log's audit self-contained.
- **A document input kind.** A PDF block is a vocabulary change (`AttachmentRef`, `ModelModality`, `ContentBlock`, both serializers, the meter); upstream's generic file kind, projected as one handle line and never bytes, gives every model PDF support for nothing.
- **Uploads.** An upload is a new image producer. Admission against the step's route happens at delivery, which needs a core path. The store is never swept. A client-sent ref could carry a forged `name`. The shape if evidence asks: host-minted upload ids that `session/prompt` cites, plus a retention row.
- **Stopping one child among several.** A child mid-delegation is read-only on every driving method (`protocol/host.ts`). Stopping one is a runtime semantic: which result does the parent's call get?
- **What projection would a rename need?** `session/title` is last-wins, but nothing reads the CURRENT title cheaply: a name chosen at seq 5,000 is nowhere near the bounded prefix `persistence.list()` reads. A sidecar, a writer-maintained stamp, or a real projection store (upstream mounts one by default).
- **What does a session present of itself to a provider?** DeepSeek's `user_id` gives each id its own rate budget and OpenAI's `prompt_cache_key` routes its cache (upstream sends the session id, and by default uploads the whole log to DeepSeek); MiniDSH sends neither. One decision for both. Separately, Anthropic caps a request at 32 MB with a 413 that maps to `INVALID_REQUEST`, which nothing retries and nothing compacts.
- **`web_fetch`, and on what boundary.** A dependency-free SSRF guard over `node:https` is feasible: resolve once, refuse the whole answer set if any address is non-public, pin the socket through a validating `lookup`, re-check every hop. Open: HTML extraction without a dependency, the proxy hop (DSH dropped its guard on 2026-10-20), and fetch as the widest exfiltration channel.
- **One egress world, or a fetch per tool?** S18's search fetches in its own body and records nothing; S20's browser fences itself inside Chrome instead (a proxy it owns, resolver rules). A shared egress provider could record `effect/recorded{network}` and fence what leaves; per-tool boundaries keep each tool's consent and no common one.
- **Does MiniDSH publish an importable surface?** A module-loaded plugin's own imports do not resolve from an installed package. An `exports` map is a compatibility promise; the first out-of-tree plugin decides (S22.2's launcher runs the CLI over its process contract and needed none). Skills do not need it.
- **Signing, then updates.** The installers are unsigned, so updates are a release page and a person runs the new installer (S22.2). An identity (Windows: SignPath Foundation, free for OSI projects, or Artifact Signing; macOS: Developer ID plus notarization) is what an updater (electron-updater on GitHub Releases) needs before it can be more than SHA-512 over a channel whoever publishes a release controls.
- **A per-boot identity for the lease.** Uptime sees a reboot only when the resume comes earlier in the new boot than the lock was taken in the old (`persistence-jsonl`); Linux has `random/boot_id`, Windows nothing without spawning a process.
- **A GUI launch's environment on macOS and Linux.** It lacks the login shell's exports and PATH: keys go through `credentials.json`, and agents see the session's PATH. DSH probes the login shell (`$SHELL -ilc`, bounded, delimiter-framed); MiniDSH waits for a macOS build someone validates by hand.

## 4. Development record

One entry per session: what it decided and the measurements that still matter; the detail is in the commits.

- **S22.2 Desktop application (2026-11-20).** Its decisions are ARCHITECTURE §8, §9, §12, §13 and `desktop/`:
  - an Electron launcher runs the bundled CLI's `web --json` on a bundled official Node (RunAsNode fuse off) and never imports the runtime, so §3's importable surface was not needed;
  - main spends the token and injects the cookie per request on loopback (no scheme, no proxy, nothing in the jar); the Web UI has no preload, and the shell overlay is its own webContents and scheme;
  - one serialized lifecycle: busy asked over the wire on demand, confirm, then save, then stop by stdin's end;
  - in the runtime: `web --json`, a graceful `web` stop, `--workspace`, `minidsh credentials`, and a lease reclaimed after a reboot by uptime.

  DSH `2e39e704` was the reference, studied from source only.

  **User decisions:** unsigned installers; closing quits after a runtime-informed confirm (no tray); in-app key entry through a CLI command; a manual update check; Windows plus an AppImage plus a CI-built macOS zip.

  **Measured (P0; Electron 45.3.4, electron-builder 26.18.1, this non-admin host):**
  - with the file-privilege fuse off, `file://` cannot read the asar, hence the overlay's own scheme;
  - `onBeforeSendHeaders` reaches the navigation, every script, the stylesheet and the WebSocket upgrade;
  - a Windows pipe on stdin reads `isFIFO() === false` (mode 0x1000), so the stop's stdin rule is by exclusion;
  - pnpm's release age refused Electron 45.4.1, so 45.3.4;
  - installers: Windows 127.9 MiB, AppImage 165 MiB (DSH's 286 MiB).

  **Found:**
  - 2 design critics: 7 design changes (a preload per webContents, the libuv Job on parent death, a node shim re-parsed by cmd.exe, a standing subscriber parking asks, EPIPE mid-disposal, the installer killing a runtime, port exclusions);
  - lane A: a wall-clock lease rule could steal a live lease;
  - only the packaged E2E: a quit during startup dropped, the uninstaller refusing itself, task-dialog buttons exposed as Panes;
  - a 3-lens review, about 40 findings, 6 major: two runtimes after a mid-start folder change; settings saved before the confirm; a missing folder blocking every start; a quit unable to stop a booting runtime; the AppImage forcing `--no-sandbox`; two key saves losing one;
  - the 2-lens pre-push review, 17 findings, 4 major: a queued folder change dropped by a later one; a keys form that could not be closed; the lease rule blind to a resume later in the new boot (narrowed, §3); an AppImage refusing its neighbours. CI could not have caught a missing installer or an unsigned PR macOS build;
  - CI's first run: on Windows a just-released lock stays delete-pending and its re-create answers EPERM, killing a concurrent `credentials set` (6 of 100 writers here); fixed.

  **Live:**
  - The INSTALLED app on DeepSeek: a fix through the window (3 approvals clicked, 23 s); a killed runtime restarted and resumed (`completed → interrupted → completed`); a quit mid-turn confirmed (`cancelled`, no lease); a key saved by the form and used; the agent's `node` the bundled 24.22.3.
  - The `web` and `live` arcs once per host.
  - Keyless E2E: 5 of 5 on Windows (installer included), 4 of 4 twice under WSLg.

  **Gates:** Windows 2,029 passed, 30 skipped; WSL 2,046 passed, 11 skipped. **Docs:** ARCHITECTURE 54.8 → 51.9 KB, README 30.1 → 28.4; 13 statements restored in claim review.

  **Agents:** 17 of 17: 5 research, 2 critics, 2 lanes, 3 review lenses, 2 compaction authors, 1 claim reviewer, 2 pre-push lenses.

- **S22.1 Terminal TUI redesign (2026-11-19).** Its decisions are ARCHITECTURE §8, §11, §13 and `app/terminal/`: the terminal is a protocol client (`session/resume` and `session/fork` on the wire, the bypass deleted); one presentation model, two renderers; a consent is a lone key, armed once on screen. Codewhale (`e1364cab`) was the design reference.
  - **User decisions:** keyboard scrolling, no mouse capture; the S22 accent; no skill gesture yet; the wire change with the full 3×-per-host gate.
  - **Measured in Windows Terminal (`keys.ts`):** libuv drops Shift and Alt from Enter; Ctrl+Enter arrives as LF; an unbracketed paste comes in 1024-byte chunks split at `\r`; the wheel arrives as arrows on the alternate screen.
  - **Found:** only driving the packed tarball found `--plain` never parsed; the reviews' worst were an armed band taking a `y` typed mid-word and a stale preset after `/new`.
  - **Gates:** every arc 3× per host, Windows 51 of 51 and WSL 51 of 51; Windows 1,898 tests, WSL 1,915. 14 agents.

- **S22 Web UI redesign (2026-11-19).** Its decisions are ARCHITECTURE §3, §8, §11, §13 and `app/web/` (`display`, the conversation fold, a strict CSP).
  - **User decisions:** a sea-teal accent; image previews and DSH's MIT icon set; finished turns collapsed.
  - **Found:** only the live run found that following stopped at the first approval: Chrome fires `scroll` for a shrinking viewport before any resize callback.
  - **Open:** on Windows the context arc passed 5 of 6; one keyless replay consumed 7 of its 8 recorded summaries, cause not found (S22.5 reruns it). 18 agents.

- **S21.1 Continuations and process hygiene (2026-11-08).** Its decisions are ARCHITECTURE §4, §6, §7 and the code. **User decisions:** the resume-ordering defect pulled in from S22; containment for all three pwsh shapes. **Measured:** containment costs ~+55 ms on a ~610 ms pwsh start (`shell-stdio/process.ts`). **Found:** a design critic, 16 findings; a 3-lens review, 12 with 4 major; what was applied is at the code. **Live:** delegation, parallel, verification, authority and context once on Windows; jobs 3/3 on Windows and under WSL with bwrap; delegation once under WSL; 0.19 CNY. **Gates:** Windows 1,454 passed with 28 named skips; WSL 1,470 with 10. DSH at `fcc0ad46` (a manual compaction there, `runMaintenance`, is joined unbounded). **Agents:** 9 of 9.

- **S21 Multi-actor execution (2026-10-31).** Its decisions are ARCHITECTURE §6 and the code; the kernel needed nothing. **User decision:** the parent waits. **Phase 0, the gate:** 25 of 25 first delegating messages carried three subagent calls. **Measured live:** joined, a step took 6.8–13.9 s against 17.3–27.7 s serial (Windows). **Found:** a 3-lens review, 9 findings, no blocker. **Live:** every arc 3× per host, the OpenAI leg 3/3. **Agents:** 16 of 16, then a 2-lens pre-push review.

- **S20.5 Hardening checkpoint B = 1.2.0 (2026-10-25 → 10-26).** Its decisions are the map and the code (§2); before a write was judged by its handle, 13 of 49 racing writes landed outside on Linux, none after. **User decisions:** a stated SemVer exception (a silent degradation or a leaked secret may become a refusal in a minor); zod pinned at 4.6.7; the format a note, not a bump (measured: 1.1.0 continues an S17 log's unfinished job without closing it). **Found:** 8 auditors, 107 findings; a 3-lens review, 29, no blocker; CI on `release/v1.2`, four defects no local host showed; what was applied is at the code. **Live:** every arc and the three drift probes 3× per host (routing `carried` with one compaction in every run after its recalibration); the OpenAI leg 17 of 21 (gpt-5.4-mini misreads a quadrant; a 256 px image did no better, 5 of 6), so S18's 4/4 no longer holds and the next provider session re-chooses that model; 2.53 CNY. **Published** 2026-10-26 from CI on the first try (tag at `1c4328e`), then fixed a fixture from the registry on both hosts. **Agents:** 21 of 21.

- **S20 Browser verification (2026-10-19).** Its decisions are ARCHITECTURE §7, §9 and `tool-browser`, whose comments carry its measurements. **User decisions:** our own CDP client, not Playwright (13.7 MB in-process); loopback plus `allowHosts` with no consent, so a child may use it; a default row only where a browser is found. **Found:** 2 critics, 29 findings; a 4-lens review, ~40 with 2 blockers; CI's three runs, five defects no local host showed (each now at the code). **Live:** the browser arc 3/3 on Windows and under WSL 2 with bwrap, leg B's replayed screenshots byte-identical; every other arc once; 0.35 CNY; 1,252 tests on Windows, 1,268 under WSL 2. **Agents:** 17 of 17.

- **S19 Skills as data (2026-10-18).** Its decisions are ARCHITECTURE §6, §9, §12. **User decisions:** two self-contained document skills, `office` and `pdf`, written independently (Anthropic's are proprietary); the per-prompt re-read; the repository's `.agents`/`.claude` skills by default, other tools' homes only by config. **Measured:** real Word, Excel and PowerPoint open and export each built format; deepseek-flash built the report through the skill in ~20 s and 8 steps, and without it made a `.venv` for python-docx (102 s, 15 steps). **Live:** the skills arc 3/3 Windows, 2/2 WSL with bwrap, each replay byte-identical; 0.21 CNY. **Agents:** 16 of 16.

- **S18 Providers and the first network tool (2026-10-16).** Its decisions are ARCHITECTURE §4, §5, §7; the Responses API's leniency and its output caps are measured at the code. **User decisions:** Tavily, because Brave's terms forbid storing results and the log is permanent; per-query exact grants; no `web_fetch`; the Tavily key in `~/.minidsh/credentials.json`, never the environment; the OpenAI leg and the search arc local-only. **The jobs-arc flake:** 0 of 12 (the job 17–32 s under load against a 120 s wait); unexplained, its next occurrence names its half. **Live:** routing 2/2, every new arc and the drift probes once or more; 0.32 CNY, ~9 Tavily credits. **Agents:** 17 of 18.

- **S17 Jobs (2026-10-15).** Its decisions are ARCHITECTURE §4, §6, §12. **User decisions:** waking bounded (DSH's cap of 3 had stalled sessions unseen, so it went unbounded); headless stops jobs at idle and records it; a durable mode or acceptance switch ends them. **Measured:** on a host SIGKILL the job's worker survived on Windows in 7 of 7 runs and died with bwrap's `--die-with-parent` in 4 of 4. **Live:** the jobs arc 6/7 on Windows (one arc-A timeout waiting for the job's end, its shape not captured), 3/3 WSL; 0.50 CNY. **Agents:** 18 of 18.

- **S16.5 Hardening checkpoint A = 1.1.0 (2026-09-26 → 09-27).** Its decisions are ARCHITECTURE §7, §9. **Live:** every arc 3× per host, `live.yml` 8/8 on both legs, confined. **Published** 2026-09-27 from CI (tag at `cddbee0`). **Agents:** 22 against a ceiling of 20.

- **S16 Durable execution II: integrity and forensics (2026-09-26).** Its decisions are ARCHITECTURE §4, §7; a weakened acceptance is stamped into the log (user decision). `fdatasync` per line is measured at `persistence-jsonl/index.ts`. 883/899 tests; 13 agents.

- **S15.1 Documentation reset (2026-09-24).** A deletion test replaced "never delete a contract". ARCHITECTURE 96,245 → 49,485 bytes; the rewriters raised 15 suspected-false claims, one a false security claim (the bwrap hard link). 17 agents.

- **S15 Authority II: consent on the record (2026-09-23).** **Decided:** the subject rides the EVENT and the joined call the VIEW, because prompting off `session.view` hangs the terminal. **Found:** only a live arc found a delegated child accepting `none`; only the review found a many-to-one subject rendering sharing one grant key. 809/824 tests; 15 agents.

- **S14 Durable execution I (2026-09-20).** Its decisions are ARCHITECTURE §4 and §6. **Measured:** three compressors told never to delete a claim freed 0.37% of `ARCHITECTURE.md`. 752 tests; 12 agents, and a plan-mode design critique worth more than any of them.

- **S13 Route and references (2026-09-19 → 09-20).** One fixed 14-agent workflow (1.83M subagent tokens). 712 tests. **The harness silently RESUMES a workflow a usage limit killed**, at the reset: read its journal and transcript mtimes before relaunching anything.

- **Docs compaction (2026-09-10 → 09-11).** **Measured:** binding per-section maxima plus a worked example reached 52–65%. Its review raised 235 findings over 1,334 normative claims, plus one invented claim; restoring them cost ~7 KB. 25 subagents, ~3.5M tokens.

- **V1 release (2026-09-09).** 19,777 lines of TypeScript in 110 files, 1,277 of browser client, 18,027 of tests in 71. Gated on the packed tarball fixing a failing fixture through its installed bin. **Facts a release meets again:** npm logs a rewritten `bin` entry as "invalid and removed", so `package.json` spells it `bin/x`; GitHub reads the license as "Other" unless LICENSE is pure MIT with the attribution in NOTICE. DSH links rot within weeks (five dead in one check). ~1.5 CNY, ~590k subagent tokens.

- **S11.5 Hardening checkpoint / release candidate (2026-09-07 → 09-08).** **CI found what no local run could:** two assertions comparing a workspace root to itself, an `EPIPE` on macOS alone, and a `MINIDSH_EXPECT_SHELL` gate that had never executed. 676 tests; ~3 CNY.

- **S11 Confinement & CI (2026-09-06).** The hint on the kernel's own denial, without which a confined host is an authority regression, costs +48 tokens of fixed prefix per request. 668 tests; ~2.1 CNY.

- **S10 Session & product surfaces (2026-09-06).** A browser turn went from 197 node insertions and 25 clears to 16 and none once a delta stopped rebuilding the transcript. 636 tests.

- **S9 Context & prompt hygiene (2026-09-05).** Bounded recall. 601 tests.

- **S8.5 Architecture review (2026-09-04 → 09-05).** One bounded workflow against the current DSH overturned three plans: extension authoring, session deletion, and where the sandbox-mode prompt sentence lives. 581 tests.

- **S1–S8 Foundation through verification (2026-08-22 → 09-02).** The kernel, the core spine, the DeepSeek adapter, JSONL persistence and the headless CLI (S1); two surfaces over one runtime and the durable op-shaped inbox (S2); authority as one replayable plane, the fence in the fs PROVIDER (S3: untested enforcement is worse than an honest `none`); what MiniDSH *is* became data (S4); metering, the compaction seam, spill, workspace instructions (S5); the model as a capability the runtime routes to (S6); the web surface and tier-aware backpressure (S7: a 400-turn session is 103,201 events and 17.0 MB); the attachment plane and a verifier that is a composition row (S8). The checkpoints S1.5, S5.5 and S7.5 found three documented invariants untrue in code, a crash repair that resumed a history every OpenAI-compatible wire refuses, and a wire client that could prompt a LIVE delegated child.
