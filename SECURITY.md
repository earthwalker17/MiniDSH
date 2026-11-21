# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository: <https://github.com/earthwalker17/MiniDSH/security/advisories/new>. Do not open a public issue for a defect that can be exploited.

Include what you can of: the version (`minidsh --version`), the operating system, the `enforcement` value on the session's opening `sandbox/mode` event (`minidsh sessions show <id> --json` carries it; `--audit` prints it for a confinable mode), and the session log if one is involved: `minidsh sessions show <id> --json`, or the file under `~/.minidsh/sessions/`. The harness records credential *names*, never values, but a command's output is logged as it was printed, so read a log before attaching it. This is a small project with one maintainer; expect an acknowledgement within a week.

## Supported versions

The latest 2.x release.

## Threat model

MiniDSH is a coding agent that edits files and runs commands on your machine. It trusts the person who started it, who is its one principal: there are no accounts. It also trusts whatever already runs as that person, every file under its own home directory (`~/.minidsh` by default), and its composition, because a plugin that `composition.json` names is loaded as code. It does not trust the model, the contents of the repository it works in, web pages and search results, or the output of any tool: any of them can carry text written to steer the model. So the model is never the boundary. It proposes, policy decides, the effect boundary enforces, and each decision is a durable event in the session log. A steered model can still do anything its session's authority allows, so each section below says where that authority stops, what enforces the stop, and what it does not do.

Known limitations are listed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 13. Section 7 describes the authority model.

## Where the boundaries are

### File writes

The editor tool writes inside the session's workspace under `workspace-write`, nowhere under `read-only`, and anywhere under `danger-full-access`. The `fs` provider enforces this in process (`src/capabilities/fs-local/index.ts`): it follows symbolic links, checks the result against the session's recorded sandbox mode, refuses before any effect, and then checks the file it opened, not only the name.

It does not:

- Restrict reads. Any tool can read any file the person can.
- Detect a hard link. A hard link inside the workspace to a file outside it is written through.
- Fully defend against a concurrent process. One that swaps a directory for a link during a write can leave an empty file or directory outside the workspace. On macOS and Windows, where the opened file is checked by name, a well-timed swap can also let content through.
- Govern the shell, which has its own boundary.

### Shell commands

Where the operating system offers a backend, the shell runs inside it and the kernel refuses a write outside what the session's mode allows. Linux uses bubblewrap (`src/capabilities/shell-stdio/confine/bwrap.ts`), macOS uses Seatbelt through `sandbox-exec` (`confine/seatbelt.ts`), and Windows has none. A backend is probed by running its real read-only profile (`confine/index.ts`). A host where the probe fails is treated as having none.

With no backend a command is refused by default. The model can retry it with an escalation, a person is asked, and an approved escalation runs that one call unconfined. A session can instead record that it accepts no confinement (`--accept none`, or `/accept none`): its shell then runs unconfined without asking, and the editor's fence still applies. The acceptance is a durable event in the session's log. As a flag to `serve`, `web` or `chat` it is the default for every session that process opens, and a weakened default is written into each one for each confinable mode, so a stored log says what it accepted: a line, or `full` by its absence. Where a backend works, accepting less changes nothing.

Confinement governs the files a command and the processes it starts write directly. It does not govern a service the command can reach. On Linux the bubblewrap profile hides the user runtime directory (`/run/user/<uid>`: the session D-Bus, the user systemd, a rootless container engine) and withholds `DBUS_SESSION_BUS_ADDRESS`, because a confined command could otherwise ask the user's own systemd to write anywhere. That escape was reproduced under WSL 2 on 2026-11-21 in both confined modes, and is closed by hiding the directory. What stays reachable and can act for a confined command with its own authority: the system bus and the services behind it, a docker socket for a member of the docker group, abstract sockets, any other Unix socket the profile does not hide, and every service listening on loopback (the network is shared). On macOS, Seatbelt leaves launchd and LaunchServices reachable. This is not hardened.

It also does not:

- Confine the network. A confined command reaches the internet.
- Stop a write through a hard link that already sits in the workspace (measured under both backends). Neither backend lets a command create one across the boundary.
- Measure each call. `full` enforcement is a claim about the profile, proved by the probe.
- Reach a command that is already running. After a mode is narrowed, the persistent shell is replaced when its next command arrives.

A background job runs under the mode and acceptance its start resolved, never under an escalation, and a change of either ends it. If the MiniDSH process is killed, a job can run on unsupervised on macOS and on Linux without confinement. On Windows each PowerShell the harness starts holds what it starts in a kill-on-close Job (`shell-stdio/process.ts`). A process created through WMI or the Task Scheduler, or one that asks to break away, escapes it, and under Constrained Language Mode the Job is not applied.

### Approvals and grants

An approval asks a person about what the runtime will do. The request carries a subject the harness builds from the validated call arguments: the command, and the sandbox mode and enforcement it would run under (`src/capabilities/tool-shell/index.ts`). It also carries the call as the log recorded it, up to 16,384 characters, with a count of what was left out (`src/core/approval/events.ts`). The model's justification appears beside these, never in place of them. The browser always shows the recorded call; the terminals show it when there is no subject or the subject was cut (a command past 4,000 characters). Control characters are stripped from model-written text where it is recorded for an approval and where a terminal renders it (`src/app/present.ts`).

A yes covers one call. The host may offer to extend it to that exact action for the rest of this run of the session, and a surface cannot invent that offer. Such a grant is a durable event, keyed on the tool and the exact subject. It ends when the sandbox mode, the approval policy, the acceptance or the preset changes, and when the run ends: a resume or a fork asks again. It can be revoked.

A delegated child agent opens under its parent's mode as a ceiling, with approvals pinned to `never`. The ceiling is recorded when the child is created, and a widening is refused before dispatch.

It does not:

- Ask in a headless run. Nobody is there to answer, so a request is refused unless the run was started with `--approve`, which answers yes to every request, or the composition lists that exact command (`src/capabilities/approval-headless/index.ts`).
- Judge the command. What a person approves, runs.
- Reach a child that is already running. Narrowing a parent leaves its running children on the authority they opened under until their turn ends.

### The environment and keys

A shell child's environment is built, not inherited (`src/core/process.ts`). It leaves out the credential names this deployment declared and every `MINIDSH_*` variable, and under bubblewrap the session bus address. Provider keys are redacted from provider and proxy errors before those reach the log, the model or stderr, and a base URL that carries a username or password is refused (`src/core/llm/wire.ts`).

It does not:

- Withhold anything else. A secret the deployment did not declare, `SSH_AUTH_SOCK` and proxy variables all pass through.
- Hide `~/.minidsh/credentials.json`. Reads are never fenced, so anything that runs as you can read it, a confined command included.
- Encrypt anything. Session logs hold prompts, file contents and tool output in clear text.
- Change the mode of a file it did not create. On Linux and macOS what this version creates under `~/.minidsh` is for the owner only (0600, and 0700 for the sessions directory). A log or directory from an earlier version keeps its mode until you run `chmod -R go-rwx ~/.minidsh`. Windows has no mode bits.

### The network

No backend separates the network, so a shell command reaches the internet and every service listening on loopback, in every mode.

The browser tools are on by default where Chrome, Edge or Chromium is installed. They drive a headless browser the harness starts over a pipe, never a debugging port, with a fresh profile and downloads refused (`src/capabilities/tool-browser/launch.ts`). Inside the browser, a proxy the harness owns and resolver rules leave it `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, the workspace's own files and any `allowHosts` the row names (`tool-browser/fence.ts`). A canary request proves that fence at each launch, or the launch is refused. The fence is drawn around the internet, not around this machine.

The browser does not:

- Ask, or leave an effect record. It reaches every service listening on loopback, in every sandbox mode and from a delegated child, and such a service may act or relay on its own authority.
- Pause a popup's own requests. A window a page opens is closed when the browser announces it, after its first requests have left. Those meet the network fence but not the file rule (`tool-browser/page.ts`). In 20 tries on 2026-11-21 such a popup's script never ran before the close. That is a measurement, not a guarantee.

`web_search` is opt-in. It asks before every query leaves the machine, on a line naming the query, where it goes and the credential it goes as, and it follows no redirect (`src/capabilities/tool-web-search/index.ts`). Results reach the model behind a fixed notice that they are untrusted content. That consent is the only authority over what leaves: nothing confines or records the request. A delegated child is not offered the tool, and a headless run needs `--approve` to use it.

### Repository content, skills and the composition

A repository can say how it likes its code. It cannot say what the harness may do: there is no workspace configuration layer. Its `AGENTS.md` and its `.agents/skills` and `.claude/skills` are shown to the model like any file it might read. A skill's text can steer the model, its scripts run as ordinary shell commands under the session's authority, and a repository skill never replaces one of yours or a bundled one. On Linux and macOS a `.git` above the working directory that another user owns ends the search for both at the working directory. On Windows that owner check is not made.

`~/.minidsh/composition.json` and any plugin it loads are trusted as code. `minidsh config` warns about authority-sensitive rows a layer changed. It does not sandbox them.

### The web host

`minidsh web` binds loopback unless `--host` says otherwise (`src/app/web.ts`). It prints one link carrying a launch token. The first request that presents the token spends it and receives a signed, HttpOnly, SameSite=Strict cookie. Every later request and the WebSocket upgrade need that cookie, the `Host` header it was issued for, and an `Origin` header that is absent or the server's own. The page refuses to be framed, and its content security policy allows only scripts the host serves.

It does not:

- Identify anyone. Whoever opens the link first is the one principal.
- Provide accounts or TLS under `--host`. On a non-loopback address the link and the cookie cross the network in clear text. Binding there is the operator's decision.
- Scope the cookie to its port. A cookie is scoped to a host name, so the browser also sends it to any other server on that loopback name, for example a dev server the agent started on another port. A client that presents the cookie with a `Host` header equal to the authority inside it and no `Origin` header can open the WebSocket and drive a session. This was reproduced with a real browser on 2026-11-21: a client holding only that cookie created a session and widened its own authority. The cookie stays valid until the `minidsh web` process stops. This release documents the defect. A redesign follows it.

Until then: open the link in a browser profile you use for nothing else, or use the desktop app, and stop the web host when you are not using it. The desktop app is not affected, because its cookie never enters a cookie jar.

### The desktop app

The desktop app is an Electron launcher around the same runtime, and it adds no boundary of its own. It never imports the runtime. It starts the bundled CLI's `minidsh web --json` on a bundled official Node.js, spends the launch token itself, and attaches the cookie to its own window's requests to that one address, request by request (`desktop/src/main.ts`, `desktop/src/guards.ts`). The window that shows the Web UI has no preload script and no Node.js access, and other addresses open in your browser. Electron's main process runs no user code. Four fuses hold that (run as Node, `NODE_OPTIONS`, the inspector arguments, extra `file:` privileges), and CI reads them back out of each packed binary (`desktop/scripts/check-fuses.ts`). A packaged app refuses to start with a remote debugging port.

It does not:

- Carry a publisher's signature. All four installers are unsigned (the macOS builds are signed ad hoc, which identifies nobody), so the operating system's publisher check does not vouch for them and may warn or block at first run. Compare the installer's SHA-256 with its line in `SHA256SUMS` from the same release. That detects a damaged or substituted download, not a compromised repository.
- Update itself. Help, Check for Updates asks GitHub for the latest release and offers to open its page. A fix arrives when you download and install a new release.
- Protect its own files. The per-user install is writable by anything running as you, the runtime inherits `NODE_OPTIONS` from the environment, and Help's developer tools show the cookie.
- Always run Chromium's sandbox on Linux. Where unprivileged user namespaces are unavailable the AppImage starts without it, and `main.log` says so.
- Have hands-on macOS validation. The two macOS builds are launched and driven in CI only.

### Releases and supply chain

A `v*` tag publishes the npm package and a GitHub release from CI (`.github/workflows/release.yml`; [CONTRIBUTING.md](CONTRIBUTING.md#releases) walks through it). No npm token exists: npm's trusted publisher is keyed by this repository and that workflow file's name. The workflow refuses a tag that is not on `main` or disagrees with `package.json`, and a commit that has not passed `check.yml` and an unfiltered `live.yml`. The installers are built from the one packed tarball beside a SHA-256-pinned Node.js, and the package's provenance attestation is verified after the publish. The npm package has one runtime dependency, `zod`, pinned to an exact version.

It does not:

- Protect publishing beyond the repository. Every guard above is a step of the workflow file at the tagged commit, so anyone who can push a `v*` tag here can publish `minidsh`: repository write access is publish access. The guards hold against a mistake, not against a write credential. Limiting who may push tags or to `main` is the repository owner's setting.
- Pin every action. The publish job runs only GitHub's own actions at fixed commits. The other jobs use actions by tag.
- Audit what the installers bundle. They redistribute builds of Electron (with Chromium) and Node.js made by those projects (`NOTICE`), and only the Node.js archive is checked against a digest pinned here.

## Scope

We would like to hear about:

- a write that lands outside the workspace on a confined host without an approval, other than through the hard link and the concurrent swap described under File writes;
- a confined command on Linux that reaches a socket in the user runtime directory;
- a browser that reaches a host other than loopback and the hosts its row allowed;
- a provider key that the harness put in a log, an error or a tool result;
- an approval whose recorded subject or reason differs from what the person was shown, or from what the call runs;
- two different actions that share one grant, or a grant that survives a narrowing of the session's authority;
- a query that leaves the machine without the consent its line showed, or with characters the line did not show;
- a way to reach the web host without the cookie, or the desktop's cookie on any request but its own window's to its own runtime;
- a session log that records less authority than was exercised;
- a way for a delegated child to widen its ceiling;
- a way for repository content to change what the harness is allowed to do, as opposed to what the model is told;
- a packed desktop binary whose fuses differ from the four above.

Out of scope is what this page says is not defended: what the model does inside the authority a person gave it, anything that needs code already running as the same user, a plugin or composition a person installed, a service a confined command or the browser reaches, exposure chosen with `--host`, the missing publisher signature, and the web cookie's scope until its redesign.
