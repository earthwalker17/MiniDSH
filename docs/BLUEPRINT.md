# MiniDSH Blueprint

What comes next, the route there, what is undecided, and a compact record of how the system arrived. `ARCHITECTURE.md` (beside this file) is the current shape and its limitations; this file is direction and the measurements the architecture map does not carry. Its budget is in `scripts/check-docs.ts`; past 90%, compress §4 first (older entries collapse to what a later session reuses).

## 1. Next session — S21.1 Continuations and process hygiene

S21 found two carried items independent of the execution model, and the user moved them here (plan mode, 2026-10-31):

- A resumed or forked child keeps its ceiling, pins, depth and S21's width, but loses what `setup` narrowed: tool filter, network denial, persona, the delegation tool hidden at the cap (ARCHITECTURE §13). The shape is S21's width: narrowing as opening facts in the CHILD's log, re-applied by every lifecycle. Not a `ResumeAgentOptions.setup`, which a CLI, terminal or wire resumer cannot reconstruct. DSH re-applies a durable `subagent/descriptor`, but follows the parent's CURRENT composition when no preset was selected; that is the wrong half to copy.
- On Windows, a program a job leaves running outlives the job. Measured on this host (S21 research):
  - a job's own pwsh assigning ITSELF to a nested kill-on-close Job (Reflection.Emit P/Invoke) costs ~80 ms on a ~600 ms start, against Add-Type's 0.7–2.2 s;
  - grandchildren then die at the job's end, at a kill, and at a host kill, and the exit code is kept;
  - only WMI `Win32_Process.Create` escaped.
  No native binding, nothing driven from the persistent shell, no CIM sweep. Where Constrained Language Mode blocks the prefix, fall back to taskkill with a warning.
- Candidate: bind the idle `/compact` to its agent's lifetime (§13). It is the first consumer of an agent-owned-work primitive (§3).

**Gate.** A resumed and a forked child proved still narrow; a `Start-Process` grandchild stopped at its job's end on Windows; the delegation and jobs arcs.

## 2. Macro route (dependency-ordered; sessions are approximate)

| Session | Architectural outcome | Depends on |
|---|---|---|
| ~~S1–S13, V1~~ | ✅ The kernel and the core spine; two adapters and three tools; JSONL persistence with resume and fork; the client protocol on three carriers; authority as a durable plane with two confinement backends; composition layers; compaction and bounded recall; routing and delegation; the web surface; the attachment plane; `minidsh@1.0.0` on npm; this route and `references/`. Two hardening checkpoints and a docs compaction. **§4 is the record.** | — |
| ~~**S14** Durable execution I (2026-09-20)~~ | ✅ Every unfinished bracket closed after a crash; a durable gate-to-body fact; an effect record for the two effect families; the delegating call on the child. §4. | S13 |
| ~~**S15** Authority II (2026-09-23)~~ | ✅ A trusted consent subject and the whole call on the line; who decided and under which consent; shell-enforcement ACCEPTANCE as its own knob (the Windows fix); session-lifetime grants with revocation; the shell child's environment scrubbed. §4. | S14 |
| ~~**S15.1** Documentation reset (2026-09-24)~~ | ✅ The documents became maps sized to a reading load; references a navigation layer; compaction delegated. §4. | S15 |
| ~~**S16** Durable execution II (2026-09-26)~~ | ✅ The header as the one format mark; a per-lifecycle record of what its writer guaranteed; synced checkpoints, measured; cold `sessions verify` and `inspect`; an audit of effects; salvage; an effect-free replay over two real fixtures (kept in `test-support`: no shipped consumer). §4. | S14, S15 |
| ~~**S16.5** Hardening checkpoint A (2026-09-26 → 09-27)~~ | ✅ The record and authority planes reviewed as one system; the shell environment rule, hard links measured on both backends, consents bound to a run, the streamed answer neutralized; `references/` at `477b4f42`; the documents compacted; `minidsh@1.1.0` published from CI. §4. | S14–S16 |
| ~~**S17** Jobs (2026-10-15)~~ | ✅ `core/jobs`: owner-scoped background work as a durable bracket that repair closes `lost`; completion only through the inbox, waking bounded; the shell as the first producer; `job/cancel` and a control plane on the wire. §4. | S16.5 |
| ~~**S18** Providers and the first network tool (2026-10-16)~~ | ✅ `llm-openai` on the Responses API, its encrypted reasoning carried in the log; measured catalogs held by drift probes; `tool-web-search` opt-in under per-query consent, never reaching a child. §4. | S15 |
| ~~**S19** Skills as data (2026-10-18)~~ | ✅ `capabilities/skills`: a skill list the model may use, one durable message read with ordinary tools; `office` and `pdf` as data on Node alone. §4. | S15 |
| ~~**S20** Browser verification (2026-10-19)~~ | ✅ `tool-browser`: our own CDP client over a pipe, one browser per agent, fenced inside Chrome to loopback and the workspace, proved per launch; image admission and process hygiene moved into core. §4. | S15, S17 |
| ~~**S20.5** Hardening checkpoint B (2026-10-25 → 10-26)~~ | ✅ The widened runtime reviewed as one system: one spawn home, bounded reads, a write judged by its handle, all-or-nothing authority switches, one grant rule, one provider wire, a two-job release; `references/` at `22ddee37`; 1.2.0 from CI. §4. | S17–S20 |
| ~~**S21** Multi-actor execution (2026-10-31)~~ | ✅ No scheduler: concurrency joined at the step (concurrency-safe bodies behind one ordered lane, results in model order); parallel foreground delegation, bounded by a durable per-agent width; replay keyed by delegation; an atomic editor CAS; jittered retry. §4. | S20.5 |
| **S21.1** Continuations and process hygiene | a child's narrowing as opening facts every lifecycle re-applies; Windows job self-containment; the idle `/compact` bound to its agent (§1) | S21 |
| **S22** Surfaces: product pass and the Desktop launcher | fork and resume on the wire; terminal and browser quality; uploads; tool display facts; Desktop = launcher + webview | S17 |
| **S22.5** Hardening checkpoint C = V2 release candidate | — | S21.1, S22 |

**The ordering principle: deepen the record before widening the runtime.** Every later capability adds a new kind of effect or a new concurrent actor, and each must be expressible as log facts, under recorded authority, with a recovery rule, so those three come first. One concept runs through the first cluster: a core **effect vocabulary** (what a call is about to do and what it did, written by trusted code from validated arguments, never model prose) with three consumers: the crash record (S14), the consent subject and grants (S15), the audit of effects (S16). Authority precedes jobs because on Windows a background job cannot exist while every shell call is a one-shot escalation. **Checkpoints follow clusters of architectural change**, never every session: the record and authority planes; the widened runtime; multi-actor and product. Each `.5` does what CLAUDE.md §6 says.

**After S21: children stay foreground.** Several run at once inside the parent's step. Background or continuable children wait for evidence that a parent must keep working, or be talked to, while its children run. Their recorded home is §3. *Not:* agent teams, mailboxes, schedulers, swarm presets.

**S22 — surfaces.** `session/fork` and resume-without-prompt on the wire (a resume the host's flags refuse, today, may lose the restored prompt its cancelled first turn claimed), the terminal's beside-the-wire bypass deleted; `publishView` on a status change; a graceful web stop and `web --json`; a terminal line editor and status line; browser markdown, cards, a model picker, uploads and attachment reads; tool KIND on the wire so no surface hard-codes a tool name, and a pooled result line naming its call; stopping or showing one child among several; Desktop as a packaged launcher plus a webview over the existing carrier; the importable-surface decision; the remaining visual assets (a terminal recording, a browser screenshot, a social preview). *Not:* a second runtime, surface-held state.

**Still refused, with the reason:** model-written extensions (upstream replaced its own with gated plugin installs; `node:vm` is no boundary); an MCP bridge (no demonstrated need); a Windows confinement backend (native bindings, standing ACL changes, `partial` today) and Landlock (a prebuilt native launcher); session deletion (no authority above the append-only seam, none upstream); PTC; a session search index; per-user identity; agent teams.

## 3. Open questions (a decision is pending; the limitations themselves live in ARCHITECTURE §13)

- **Detached children, when evidence asks.** The S21 panel recorded their home:
  - a `subagent` JobKind whose process is the child: `exited` is its run, `kill` its disposal, its output its answer;
  - one `jobs.quiesce` replacing the copied whenIdle → stopAll;
  - root-only;
  - a `job_ids` join on `job_output`.

  DSH left job-backed children over continuation (two FIFOs, two cancel authorities, one terminal fact against a multi-turn residency), not over one-shot children. First, though, comes an agent-owned-work primitive: lifetime-derived cancel, join, bounded stop, end recorded before detach. The driver, jobs, compaction, the host and tool-subagent each rebuild part of it today; its first consumer is the idle `/compact`.
- **A second surface writer.** Only the compaction planner enforces "a replace never separates a call from its result", and the session invariant admits a `replace`-op `user/message` outside a step but not a `tool/result`. A pruner would be that second writer; the rule moves into the session when one exists.
- **Workspace-lifetime grants.** S15 shipped the session-lifetime shape and the identity any durable grant needs (tool plus exact subject), so what is left open is only the STORE. One that outlives a session cannot live in one log, `settings` may not own authority, and no workspace layer exists: a home-side store keyed by canonical root, COPIED into opening facts, is the only shape that keeps a stored log's audit self-contained.
- **A document input kind.** A PDF block is a vocabulary change (`AttachmentRef`, `ModelModality`, `ContentBlock`, both serializers, the meter); upstream's generic file kind, projected as one handle line and never bytes, gives every model PDF support for nothing.
- **A person invoking a skill.** DSH injects a skill's body when a user types `/name`; MiniDSH has no gesture and hides a `disable-model-invocation` skill entirely. A surface could send a prompt naming the listed path (no runtime change) or a plugin message; S22 decides, beside tool KIND on the wire.
- **What projection would a rename need?** `session/title` is last-wins, but nothing reads the CURRENT title cheaply: a name chosen at seq 5,000 is nowhere near the bounded prefix `persistence.list()` reads. A sidecar, a writer-maintained stamp, or a real projection store (upstream mounts one by default).
- **What does a session present of itself to a provider?** DeepSeek's `user_id` gives each id its own rate budget and OpenAI's `prompt_cache_key` routes its cache (upstream sends the session id, and by default uploads the whole log to DeepSeek); MiniDSH sends neither. One decision for both. Separately, Anthropic caps a request at 32 MB with a 413 that maps to `INVALID_REQUEST`, which nothing retries and nothing compacts.
- **`web_fetch`, and on what boundary.** A dependency-free SSRF guard over `node:https` is feasible: resolve once, refuse the whole answer set if any address is non-public, pin the socket through a validating `lookup`, re-check every hop. Open: HTML extraction without a dependency, the proxy hop (DSH dropped its guard on 2026-10-20), and fetch as the widest exfiltration channel.
- **One egress world, or a fetch per tool?** S18's search fetches in its own body and records nothing; S20's browser fences itself inside Chrome instead (a proxy it owns, resolver rules). A shared egress provider could record `effect/recorded{network}` and fence what leaves; per-tool boundaries keep each tool's consent and no common one.
- **Does MiniDSH publish an importable surface?** A module-loaded plugin's own imports do not resolve from an installed package. An `exports` map is a compatibility promise; the first out-of-tree plugin decides, or S22 if its launcher hosts the runtime in-process rather than over the carrier. Skills do not need it.

## 4. Development record

One entry per session: what it decided and the measurements that still matter; the detail is in the commits.

- **S21 Multi-actor execution (2026-10-31).** Its decisions are ARCHITECTURE §6 and the code:
  - no scheduler;
  - concurrency joined at the step: concurrency-safe bodies behind one ordered lane, results in model order, drained, never abandoned;
  - foreground children as the first such body;
  - a child's width as a durable `agent/options` fact, never a counter;
  - replay keyed by delegation;
  - an atomic editor compare-and-set;
  - retry jitter on top of `retry-after`.

  The kernel needed nothing for this. Its gap, agent-owned work, matters only for detached children (§3). DSH has no scheduler either, and moved its children to async activations for continuation, not throughput.

  **User decisions:** the parent waits rather than letting children run in the background; continuation narrowing and Windows containment go to S21.1.

  **Measured, Phase 0 (gate before code):**
  - 25 of 25 first delegating messages carried three subagent calls (flash 14 of 14 with or without guidance, pro 11 of 11);
  - on tiny tasks flash read the files itself before delegating in 9 of 18 runs;
  - the serial executor's delegating step took 24.9 s and 28.9 s, each the sum of its children.

  **Measured, live:** joined, the step took 6.8–13.9 s against 17.3–27.7 s serial on Windows, and 4.0–5.7 s against 11.1–13.7 s under WSL. Children finished out of model order in 7 runs, and results committed in model order in every run.

  **The panel** (a critic and two steelmen) agreed the design wins if and only if models batch, and supplied:
  - the slot and ordered-commit discipline;
  - the step-scoped abort;
  - the durable width;
  - the live floor before `step/end`.

  **The review (3 lenses, 9 findings, no blocker):**
  - a cancel during a lost write's drain ended the turn `cancelled`;
  - a provider throwing synchronously wedged the agent under the new `step/end` rule;
  - `retry-after` swallowed the jitter (1000 ms ×4);
  - the arc's replay could not see a mis-bound child, because the world alone is the same.

  **Live:** every arc 3× per host on the final loop. Windows passed 3/3 for every arc, the OpenAI leg 3/3. WSL with bwrap passed 3/3 for every arc but `parallel`, 2/3: a child named an absolute path a fresh replay root refuses. Replaying in the run's own workspace fixed it; reruns 3/3 per host.

  **Gates:** Windows 1,414 passed with 32 skips; WSL 1,438 passed with 4. Two timing-bound tests (office's 2M-node test, the WebSocket ping) failed under load and passed alone.

  **Cost:** DeepSeek 6.08 → 3.43 CNY.

  **Agents:** 16 of 16 (7 research, 3 panel, 1 implementer, 3 review, 2 docs), then a 2-lens pre-push review of the later fixes: the driver clean; the arc's per-call check blind to siblings answering alike, so it now compares each child's own tool calls.

- **S20.5 Hardening checkpoint B = 1.2.0 (2026-10-25 → 10-26).** Its decisions are the map and the code: one spawn home, bounded reads, a write judged by its handle (13 of 49 racing writes landed outside on Linux before, none after), all-or-nothing authority switches, one grant fold, one provider wire, a two-job release. **User decisions:** a stated SemVer exception (a silent degradation or a leaked secret may become a refusal in a minor); zod pinned at 4.6.7; the format a note, not a bump (measured: 1.1.0 continues an S17 log's unfinished job without closing it); Windows job descendants routed to S21. **Found:** 8 auditors, 107 findings (EMFILE unhandled at every spawn, the Kelvin-sign fence escape on Windows, a procfs-linked `SKILL.md` OOM-killing the host, arcs whose separating assertion was an `every` over nothing); a 3-lens review, 29, no blocker (a symlinked `.git` bypassing the ownership check, a filtered `live.yml` satisfying the release guard); CI on `release/v1.2`, four defects no local host showed (a summarizer spending its answer on tool calls). **Live:** every arc and the three drift probes 3× per host on the final tree (routing `carried` with one compaction in every run after its recalibration); the OpenAI leg 17 of 21 (gpt-5.4-mini misreads a quadrant; a 256 px image did no better, 5 of 6), so S18's 4/4 no longer holds and the next provider session re-chooses that model; 2.53 CNY. **Published** 2026-10-26 from CI on the first try (tag at `1c4328e`), then fixed a fixture from the registry on both hosts. **Agents:** 21 of 21; a usage limit stopped one lane, the parent finished it.

- **S20 Browser verification (2026-10-19).** Its decisions are ARCHITECTURE §7, §9 and `tool-browser`. **User decisions:** our own CDP client, not Playwright (13.7 MB in-process); loopback plus `allowHosts` with no consent, so a child may use it; a default row only where a browser is found. **Measured:** a pipe launch 0.7–1.7 s, Edge's cold first start on a fresh CI runner 19–32 s (the bound is 60 s); the browser exits ~0.1 s after its parent dies; a `file:` iframe renders any local file until intercepted; WebRTC's policy holds only from the profile. **Found:** 2 critics, 29 findings (the 60 s pipeline deadline abandoning a body mid-page, EPIPE crashing the host); a 4-lens review, ~40 with 2 blockers (a WebRTC TURN host resolved through the OS, a DNS channel past the proxy; a descriptor-less spawn crashing the host); CI's three runs, five defects no local host showed (each now at the code). **Live:** the browser arc 3/3 on Windows and under WSL 2 with bwrap, leg B's replayed screenshots byte-identical; every other arc once; 0.35 CNY; 1,252 tests on Windows, 1,268 under WSL 2. **Agents:** 17 of 17 (5 research, 2 critics, 2 implementers, 4 review lenses, 2 compaction authors, 2 claim reviewers).

- **S19 Skills as data (2026-10-18).** Its decisions are ARCHITECTURE §6, §9, §12. **User decisions:** two self-contained document skills, `office` and `pdf`, written independently (Anthropic's are proprietary); the per-prompt re-read; the repository's `.agents`/`.claude` skills by default, other tools' homes only by config. **Measured:** real Word, Excel and PowerPoint open and export each built format; deepseek-flash built the report through the skill in ~20 s and 8 steps, and without it made a `.venv` for python-docx (102 s, 15 steps). **Live:** the skills arc 3/3 Windows, 2/2 WSL with bwrap, each replay byte-identical; 0.21 CNY. The claim review restored eleven compaction cuts the code still enforced. **Agents:** 16 of 16.

- **S18 Providers and the first network tool (2026-10-16).** Its decisions are ARCHITECTURE §4, §5, §7; the Responses API's leniency, its output caps and why gpt-5.4-mini validates the OpenAI leg are measured at the code. **User decisions:** Tavily, because Brave's terms forbid storing results and the log is permanent; per-query exact grants; no `web_fetch`; the Tavily key in `~/.minidsh/credentials.json`, never the environment; the OpenAI leg and the search arc local-only. **The jobs-arc flake:** 0 of 12 (the job 17–32 s under load against a 120 s wait); unexplained, its next occurrence names its half. **Live:** routing 2/2, every new arc and the drift probes once or more; 0.32 CNY, ~9 Tavily credits. Its two compaction authors raised six suspected-false claims, each confirmed. **Agents:** 17 of 18.

- **S17 Jobs (2026-10-15).** Its decisions are ARCHITECTURE §4, §6, §12. **User decisions:** waking bounded (DSH's cap of 3 had stalled sessions unseen, so it went unbounded); headless stops jobs at idle and records it; a durable mode or acceptance switch ends them. **Measured:** on a host SIGKILL the job's worker survived on Windows in 7 of 7 runs and died with bwrap's `--die-with-parent` in 4 of 4. **Live:** the jobs arc 6/7 on Windows (one arc-A timeout waiting for the job's end, its shape not captured), 3/3 WSL; 0.50 CNY. **Agents:** 18 of 18.

- **S16.5 Hardening checkpoint A = 1.1.0 (2026-09-26 → 09-27).** Its decisions are ARCHITECTURE §7, §9: a consent ends with its lifecycle; a shell child loses only declared credential names and `MINIDSH_*`. **Live:** every arc 3× per host, `live.yml` 8/8 on both legs, confined. **Published** 2026-09-27 from CI (tag at `cddbee0`) after three failed runs whose causes `release.yml` now names. **Agents:** 22 against a ceiling of 20.

- **S16 Durable execution II: integrity and forensics (2026-09-26).** Its decisions are ARCHITECTURE §4, §7; a weakened acceptance is stamped into the log (user decision). `fdatasync` per line is measured at `persistence-jsonl/index.ts`. 883/899 tests; 13 agents.

- **S15.1 Documentation reset (2026-09-24).** A deletion test replaced "never delete a contract" (S14's 0.37% floor came from that rule). ARCHITECTURE 96,245 → 49,485 bytes; the rewriters raised 15 suspected-false claims, one a false security claim (the bwrap hard link). 17 agents.

- **S15 Authority II: consent on the record (2026-09-23).** **Decided:** the subject rides the EVENT and the joined call the VIEW, because prompting off `session.view` hangs the terminal. **Found:** only a live arc found a delegated child accepting `none`; only the review found a many-to-one subject rendering sharing one grant key. 809/824 tests; 15 agents.

- **S14 Durable execution I (2026-09-20).** Its decisions are ARCHITECTURE §4 and §6. **Measured:** three compressors told never to delete a claim freed 0.37% of `ARCHITECTURE.md`. 752 tests; 12 agents, and a plan-mode design critique worth more than any of them.

- **S13 Route and references (2026-09-19 → 09-20).** One fixed 14-agent workflow (six assessors, eight DSH researchers; 1.83M subagent tokens). 712 tests. **The harness silently RESUMES a workflow a usage limit killed**, at the reset: read its journal and transcript mtimes before relaunching anything.

- **Docs compaction (2026-09-10 → 09-11).** **Measured:** a pass told never to delete a contract stopped at 90% of the original, as three earlier rewrites had; binding per-section maxima plus a worked example reached 52–65%. Its review raised 235 findings over 1,334 normative claims, plus one invented claim; restoring them cost ~7 KB. 25 subagents, ~3.5M tokens.

- **V1 release (2026-09-09).** 19,777 lines of TypeScript in 110 files, 1,277 of browser client, 18,027 of tests in 71. Gated on the packed tarball (119 entries, 251 KB) fixing a failing fixture through its installed bin. **Facts a release meets again:** npm logs a rewritten `bin` entry as "invalid and removed", so `package.json` spells it `bin/x`; GitHub reads the license as "Other" unless LICENSE is pure MIT with the attribution in NOTICE. DSH links rot within weeks (five dead in one check). Every arc failure the routing arc's marker drop, `history_read` called 0× (7 of 10). ~1.5 CNY, ~590k subagent tokens.

- **S11.5 Hardening checkpoint / release candidate (2026-09-07 → 09-08).** **CI found what no local run could:** two assertions comparing a workspace root to itself (`/private/var` vs `/var`; an 8.3 short TEMP), an `EPIPE` on macOS alone, and a `MINIDSH_EXPECT_SHELL` gate that had never executed. 676 tests; ~3 CNY.

- **S11 Confinement & CI (2026-09-06).** The hint on the kernel's own denial, without which a confined host is an authority regression, costs +48 tokens of fixed prefix per request. 668 tests; ~2.1 CNY.

- **S10 Session & product surfaces (2026-09-06).** A browser turn went from 197 node insertions and 25 clears to 16 and none once a delta stopped rebuilding the transcript. 636 tests.

- **S9 Context & prompt hygiene (2026-09-05).** Bounded recall. A review fanned out per finding reached 46 agents before the user killed it, the origin of CLAUDE.md §8's fixed count. 601 tests.

- **S8.5 Architecture review (2026-09-04 → 09-05).** One bounded workflow against the current DSH (192 claims, 228 fetches) overturned three plans: extension authoring, session deletion, and where the sandbox-mode prompt sentence lives. 581 tests.

- **S1–S8 Foundation through verification (2026-08-22 → 09-02).** The kernel, the core spine, the DeepSeek adapter, JSONL persistence and the headless CLI (S1); two surfaces over one runtime and the durable op-shaped inbox (S2); authority as one replayable plane, the fence in the fs PROVIDER (S3: untested enforcement is worse than an honest `none`); what MiniDSH *is* became data (S4); metering, the compaction seam, spill, workspace instructions (S5); the model as a capability the runtime routes to (S6); the web surface and tier-aware backpressure (S7: a 400-turn session is 103,201 events and 17.0 MB); the attachment plane and a verifier that is a composition row (S8). The checkpoints S1.5, S5.5 and S7.5 found three documented invariants untrue in code, a crash repair that resumed a history every OpenAI-compatible wire refuses, and a wire client that could prompt a LIVE delegated child.
