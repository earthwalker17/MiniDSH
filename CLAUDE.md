# MiniDSH — Project Constitution
## 1. Mission
MiniDSH is an architecture-first, local-first, small-but-complete agent harness reference implementation.
Its purpose is not to compete with Claude Code, Codex, DeepSeek Harness, or other general-purpose agents. It is a learning and systems-engineering project: study a mature harness, identify the invariants that make it composable and evolvable, then rebuild the minimum system that preserves those properties.
> **Minimal surface. Complete architecture.**
DeepSeek Harness is an **architecture textbook and behavioral oracle**, not a repository to fork and prune.
Prefer independent implementation. If code is copied or adapted, preserve required license/attribution and record provenance.

## 2. Architecture First
Architecture defines sessions; sessions do not define architecture.
Before implementing a meaningful capability, identify:
- its architectural layer and owning subsystem;
- its stable seam/contract;
- the state it owns and must not own;
- dependency direction;
- lifecycle and effects;
- how it is persisted, observed, verified, and removed;
- whether it is a runtime capability, ordinary internal logic, or application assembly;
- how multiple surfaces should interact with it.
If a feature has no clear home, treat that as an architecture problem before an implementation task.
Architecture-first does **not** mean abstraction-first. Avoid speculative frameworks, empty layers, and indirection without real boundaries. Pre-design the system space; instantiate abstractions only when they express real invariants.

## 3. Durable Architectural Questions
Always preserve clear answers to:
1. **Capability** — how capabilities are provided, discovered, replaced, scoped, and composed.
2. **State ownership** — who owns session, workspace, provider, tool, runtime, policy, and UI state.
3. **Composition** — what is fixed infrastructure, dynamically composable capability, or application assembly.
4. **Facts/history** — what canonical record explains what happened and supports inspection/resume/replay/fork.
5. **Effects/authority** — who authorizes side effects and how policy, sandboxing, approvals, and reasoning remain separate.
6. **Surfaces** — how Web, TUI, Desktop, API, and headless clients share one runtime.
7. **Evolution** — how capabilities can be added, replaced, or removed without unrelated implementation knowledge.
> **Everything evolvable has a seam.**
Do not turn “everything is a plugin” into dogma. Pure helpers, algorithms, types, and local implementation details do not need dynamic lifecycle machinery.

## 4. DeepSeek Harness as Reference
For overlapping design questions, study the **current official repository and primary sources** before relying on community summaries.
Prefer evidence in this order: current official code/behavior → official architecture/subsystem docs → implemented architecture notes/tests → Cordis paper and official DeepSeek material → secondary commentary.
DeepSeek Harness evolves rapidly. Verify current behavior instead of freezing old assumptions. Reproduce principles and invariants, not implementation complexity.

## 5. Project Documents
Use exactly four primary context documents:
- `CLAUDE.md` — stable constitution and execution rules; keep under 200 lines; change rarely.
- `docs/PROJECT.md` — stable project thesis, positioning, scope, and research context; change rarely.
- `docs/ARCHITECTURE.md` — concise current architecture map and subsystem explanation; current state, not history.
- `docs/BLUEPRINT.md` — rolling long-term engineering plan plus compact development record; what comes next and why.
`CLAUDE.md` and `README.md` stay at the repository root; the other three live in `docs/`.
At every substantive session start, read all four documents, then inspect the relevant current code before planning.
After each substantive session:
- update `docs/ARCHITECTURE.md` to the actual implementation;
- update `docs/BLUEPRINT.md`, compressing completed work and moving the next session to the top;
- delete stale claims rather than accumulating contradictory history;
- keep both bounded enough to reread every session;
- avoid duplicating the same truth across documents.
Size budgets, enforced by `scripts/check-docs.ts` in `pnpm check`: `docs/ARCHITECTURE.md` ≤ 84 KB, `docs/BLUEPRINT.md` ≤ 30 KB, `README.md` ≤ 32 KB (so the warning holds it under 30). The architecture ceiling sits just above the ~74 KB its rules alone measured at in 2026-09 (after a claim-by-claim review restored what compression had cut), not below it: a budget under the contracts is an order to delete them. Past 90% of a ceiling, the session that touches the document compacts existing sections before adding a line.
All three documents have fixed section responsibilities. New material goes into the section that owns its topic and is written to fit; a section without room is compressed in place. Never add a parallel section, a chronological appendix, or a second statement of a truth another section holds. Tables (ownership, RPC, change-location, file map, retention, arcs) are lookup material and keep every row; prose is what gets compressed. `README.md` keeps its eleven sections in order — what it is, quick start, what you get, status and limitations, the question, architecture, what it learned from DSH, the experiment, verification, documents and help, license — and is written for a first-time visitor: a user-facing command, flag, default or limitation goes into quick start or status; a claim that needs the architecture to parse belongs in `docs/ARCHITECTURE.md` with a link, not here.
A compaction ends with a mechanical claim-by-claim diff of old against new, run by something other than its author: two compactions each deleted contracts their authors did not notice.
Project docs are canonical. Documentation drift is a defect.

## 6. Blueprint and Session Policy
Session 1 must establish a coherent macro development route before feature accumulation begins.
The blueprint should define the likely architectural sequence and approximate sessions, but it may change when evidence changes the architecture.
A session exists to advance the architecture along that route. A new idea does not automatically deserve a new subsystem or session.
Use **Plan Mode** automatically for complex or architecture-affecting sessions.
Before implementation, the plan must state: the boundary being changed, why the change belongs there, invariants/contracts to preserve, implementation phases, verification strategy, and documentation impact.
Architecture decides what each session should do.

## 7. Execution and Commits
Implement in bounded phases or modules.
After each meaningful phase:
1. run relevant verification;
2. fix failures before expanding scope;
3. make a focused Git commit when the phase is coherent and green.
Do not hold a large session in one uncommitted diff.
Keep simple work simple. For low-risk local tasks, use the shortest clear solution and avoid ceremonial abstractions or analysis loops.

## 8. Sub-agents and Dynamic Workflows
Use sub-agents for bounded research, independent inspection, parallelizable implementation, test analysis, and review when this protects the main context.
The parent agent remains the architectural decision-maker and integrator.
**Fix the agent count before the run, and never let it grow during one.** A workflow's total must be readable off its script without knowing a single result. A stage whose WIDTH comes from a previous stage's output is forbidden however small each agent looks — that is what "no per-finding fan-out" means operationally, and one agent per file, failure, finding, candidate or trivial task is the shape that turns a four-agent plan into fifty. A review of N dimensions is N agents, not N × findings × verifiers. S9 wrote that multiplication and reached 46 before it was killed; the prohibition alone had been in this file since S8.5 and did not hold, because nothing made the script state a number. State the ceiling in the plan before launching (a dozen is generous, twenty is a lot), and where a stage cannot be sized in advance, do it in the parent instead.
**Verify and synthesize in the parent.** Adversarial checking is this agent reading the code, not another tier of agents; a finding worth keeping is one the parent can ground in a file and a line and, where it matters, reproduce. Prefer bounded reviewers or small fixed panels over recursive swarms.
Each delegated task needs a narrow scope, explicit boundaries, and a compact expected return.
If delegation materially increases token use without increasing output quality, stop and simplify.
A killed workflow can leave files behind in the repository: check `git status` before continuing.
Never link this repository's `node_modules` into a worktree or scratch directory: a later recursive delete of that directory follows the link and destroys the real dependency tree. It has happened twice. A worktree that needs dependencies runs its own `pnpm install`; there is no build step, so `git show <rev>:<path>` usually removes the need for a worktree at all. `.claude/hooks/guard-repo.mjs` enforces this.

## 9. Persistent Memory
Use Claude Code's available persistent memory mechanism for concise cross-session handoff.
At each substantive session end, persist: completion state; important architectural decisions not already duplicated in project docs; relevant environment facts; unresolved risks/questions; and the next intended session/goal.
Consult that memory at the next session start.
Memory is a handoff aid, not a competing source of project truth.

## 10. Verification Standard
Passing tests is necessary but not sufficient.
Every substantive session must finish with:
- relevant automated tests;
- typecheck/lint/build or equivalent checks;
- targeted invariant checks where appropriate;
- a bounded adversarial review;
- a **live end-to-end run using a real model API**.
The live E2E must exercise the real MiniDSH runtime against a real workspace/task and prove useful software-engineering work can be completed through the system. Mock-only success does not count.
DeepSeek is the default development provider unless the architecture under test requires another provider. Choose the current suitable official model at setup time instead of hard-coding stale names.
Use paid API calls deliberately and keep them bounded, but do not replace required live validation with mocks merely to save effort.

## 11. Environment and Secrets
Inspect the actual local toolchain when work depends on it.
If a missing runtime, dependency, credential, platform capability, or tool would materially lower implementation or validation quality, do not silently degrade or build a workaround merely to avoid the proper prerequisite. Tell the user, or install/configure it after authorization.
Toolchain upgrades are acceptable when justified.
Never expose, print, commit, or store secrets in the repository. Credentials belong in appropriate machine/user environment or secure credential storage.

## 12. Git and Push Discipline
Remote: `https://github.com/earthwalker17/MiniDSH.git`
Commit incrementally after verified phases.
A session is eligible to push only after:
1. planned work is complete;
2. repository verification is green;
3. adversarial review is resolved;
4. real-model live E2E passes;
5. `docs/ARCHITECTURE.md` and `docs/BLUEPRINT.md` are current;
6. the user explicitly approves the session.
Do not push without explicit user approval.

## 13. Design Restraints
Do not optimize for raw feature count, package count, directory depth, or line-count reduction.
Optimize for fewer concepts, stronger invariants, explicit ownership, narrow dependency edges, replaceable seams, readable composition, bounded model-facing surface, observable behavior, testable contracts, and low future exploration cost.
A deeper directory tree is not architecture. Dependency topology and ownership matter more than nesting.
Do not let UI state become runtime truth.
Do not let provider-specific behavior leak through the system.
Do not let model reasoning become the authority/security boundary.
Do not build separate Web, TUI, and Desktop agents; build one runtime with multiple surfaces.
Do not add compatibility layers for contracts with no real external consumer unless evidence requires them.

## 14. Final Decision Rule
When a locally convenient shortcut conflicts with a known architectural invariant, protect the invariant.
When an elaborate abstraction has no demonstrated need but a simple implementation preserves the seam, choose the simple implementation.
The goal is not maximum abstraction.
The goal is a small system whose shape remains clear as it grows.
