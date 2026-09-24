# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository: <https://github.com/earthwalker17/MiniDSH/security/advisories/new>. Do not open a public issue for a defect that can be exploited.

Include what you can of: the version (`minidsh --version`), the operating system, the `enforcement` value on the session's opening `sandbox/mode` line (`minidsh sessions show <id> --audit` prints it), and the session log if one is involved — `minidsh sessions show <id> --json`, or the file under `~/.minidsh/sessions/`. Logs carry credential *names*, never values, but read a log before attaching it. This is a small project with one maintainer; expect an acknowledgement within a week.

## Supported versions

The latest 1.x release.

## Where the boundaries are

MiniDSH is a coding agent that edits files and runs commands on your machine, so it is worth being precise about what is a security boundary and what is not. The authoritative description is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7 (authority) and §13 (known limitations); this is the summary.

- **The model is never the boundary.** It proposes; policy decides; the effect boundary enforces; every decision is a durable event in the session log.
- **File writes** are fenced inside the `fs` provider, in process, against the session's recorded sandbox mode: canonicalize, contain, refuse before any effect. Reads are unrestricted by design. The fence follows symbolic links and cannot follow a hard link, so a hard link inside the workspace whose inode lives outside it lets a write through. That is a documented limitation, not an undisclosed one.
- **Shell commands** are confined by the operating system where a backend exists — bubblewrap on Linux, Seatbelt on macOS — and the backend is *probed* functionally before the harness claims it. Windows has no backend, so by default the harness refuses to run a command confined there: the model asks for a one-shot escalation and a person grants it (`--approve` grants them all on a headless run). A session may instead record that it **accepts** weaker enforcement (`--accept none`, or `/accept none`), which runs the shell unconfined under the session's own mode with the in-process file fence intact — a durable, per-session, replayable fact, not a deployment-wide bypass. Confinement governs **file effects only**, and by path: a confined command writes through a hard link that already sits in the workspace, like the file fence. A confined command still reaches the network. Its environment is scrubbed of the credential names this deployment declared, of secret-shaped names, and of `MINIDSH_*`, but that is defence in depth, not a boundary: reads are never fenced, so `~/.minidsh/credentials.json` stays readable, and a secret that is neither declared nor name-matching passes through.
- **An approval says what the runtime will do.** The line a person answers carries a *subject* the harness builds from the validated call arguments — the command, and the sandbox mode and enforcement it would run under — plus the whole call as the log recorded it. The model's own justification appears beside that, never in place of it. A yes may be extended to that exact action for the rest of the session; such a consent is a durable event, it is offered by the host rather than invented by a surface, it dies the moment any authority knob moves, and it can be revoked.
- **A delegated child** runs under a ceiling it cannot widen; the ceiling is recorded at its creation and enforced before dispatch.
- **`minidsh web`** binds loopback by default and exchanges a one-shot launch token for a signed, HttpOnly, SameSite=Strict cookie behind a Host/Origin fence. That is reachability, not identity: whoever can open the URL is the one principal. Binding to a non-loopback address is the operator's decision.
- **`composition.json`** and any module-loaded plugin are code-equivalent trust. The harness warns about authority-sensitive rows a layer changed; it does not sandbox them.
- **Model-written text** that reaches a terminal is sanitized where it is recorded (approval reasons, at the approval seam) and where it is rendered (`src/app/present.ts`).

Things that would be vulnerabilities, and that we would like to hear about: a write that lands outside the workspace on a confined host without an approval, other than through a hard link that already existed in the workspace (a documented limitation, ARCHITECTURE §13); an approval whose recorded subject or reason differs from what the person was shown, or from what the call actually runs; two different actions that share one standing consent; a standing consent that survives a narrowing of the session's authority; a way to reach the web surface without the cookie; a session log that records less authority than was exercised; a way for a delegated child to widen its ceiling; a way for repository content (an `AGENTS.md`, a file the model reads) to change what the harness is *allowed* to do rather than what the model is told.
