# MiniDSH guide

The [README](../README.md) says what MiniDSH is. `minidsh --help` lists every command and flag.

## Install

### npm

You need Node 24 or later.

```sh
npm install -g minidsh
minidsh --version
minidsh credentials list  # which keys are set, with no model call
```

Update with `npm install -g minidsh@latest`, remove with `npm uninstall -g minidsh`. To try it without installing: `npx minidsh --help`. Your data stays in `~/.minidsh` until you delete it.

What the model's shell tool needs:

| System | Shell | Confinement |
|---|---|---|
| Windows | PowerShell 7 (`winget install Microsoft.PowerShell`). 5.1 does not work. | none: see [Approvals and the sandbox](#approvals-and-the-sandbox) |
| Linux | `bash` | bubblewrap (`apt install bubblewrap`), allowed to create user namespaces |
| macOS | `bash` | Seatbelt, built in |

### Desktop app

The desktop app is the web UI in its own window, with its own Node inside. No build is signed by a publisher, so Windows and macOS object at first.

- **[Windows](https://github.com/earthwalker17/MiniDSH/releases/latest/download/MiniDSH-Setup-x64.exe).** The installer needs no administrator rights and installs for your account. SmartScreen may warn: choose More info, then Run anyway. Where Smart App Control is on, expect it to block an unsigned installer (not tested here).
- **[Linux](https://github.com/earthwalker17/MiniDSH/releases/latest/download/MiniDSH-x86_64.AppImage).** Run `chmod +x` on the AppImage, then start it. Where unprivileged user namespaces are off (Ubuntu 24.04's default), the window runs without Chromium's sandbox and the log says so.
- **macOS, [Apple silicon](https://github.com/earthwalker17/MiniDSH/releases/latest/download/MiniDSH-mac-arm64.zip) or [Intel](https://github.com/earthwalker17/MiniDSH/releases/latest/download/MiniDSH-mac-x64.zip).** Unzip and open `MiniDSH.app`. The usual route for an unidentified developer's app is to try to open it, then allow it under System Settings > Privacy & Security > Open Anyway.

Only the Windows build was installed and used on a real machine. The macOS apps were unzipped, started and driven on CI runners only. The Linux app was driven on CI runners and under WSL 2 from its unpacked form, so the AppImage's own launcher was not run. What Gatekeeper does with a downloaded copy was not tested.

There is no updater: Help > Check for Updates asks GitHub for a newer release and offers its page. Sessions and keys live in `~/.minidsh`, shared with the npm install. The folder list lives in the app's own data folder, and Help > Show Logs opens its logs. Uninstalling removes neither.

### Verify a download

Save the release's [SHA256SUMS](https://github.com/earthwalker17/MiniDSH/releases/latest/download/SHA256SUMS) beside the download and run the line for your system, with your file's name. PowerShell prints `True` on a match. The others print the name and `OK`.

```powershell
(Get-FileHash MiniDSH-Setup-x64.exe).Hash -eq (-split (Select-String 'MiniDSH-Setup-x64.exe' SHA256SUMS).Line)[0]
```

```sh
sha256sum --check --ignore-missing SHA256SUMS  # Linux
grep MiniDSH-mac-arm64.zip SHA256SUMS | shasum -a 256 --check  # macOS
```

## Keys and models

You bring your own API key.

| Provider | Key | A model id |
|---|---|---|
| `deepseek` (default) | `DEEPSEEK_API_KEY` | `deepseek-flash` (default) |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-6-luna` |

```sh
minidsh credentials set DEEPSEEK_API_KEY
minidsh credentials list
minidsh credentials unset DEEPSEEK_API_KEY
```

`set` reads the key from standard input, and on a terminal prompts with typing hidden. It writes `~/.minidsh/credentials.json`: plain JSON, mode 0600 on Linux and macOS, the folder's permissions on Windows. An environment variable of the same name wins over the file. `list` shows where each key comes from (`env`, `store` or `absent`), never a value, and any stored name nothing uses.

```sh
minidsh chat --provider anthropic --model claude-sonnet-5
```

`--provider` alone is refused when the model in use is another provider's, and the refusal lists that provider's models. Typing `/model` and a space in the full-screen terminal lists them, as does the web UI's picker.

New sessions default to the model in `settings.json`. `MINIDSH_MODEL` overrides that, and a flag overrides both. A resumed session keeps its recorded model unless you pass a flag. [Configuration](#configuration) covers that file and proxy endpoints.

## The four surfaces

`chat`, `web`, `run` and `serve` take `--cwd <dir>`, the folder the agent works in. It defaults to the current one.

### Terminal

```sh
minidsh chat
minidsh chat --plain
```

In a real terminal `chat` takes the whole screen. `/` opens the command list, `/help` shows every key and command, Esc stops a turn, Ctrl+D quits. While a turn runs, Enter sends a message that steers it. `/resume`, `/new` and `/fork` switch sessions in place. Ctrl+J starts a new line. So does a backslash then Enter, so a message cannot end in a backslash: add a space after it. On Windows the terminal reports Shift+Enter as Enter, which sends, and Ctrl+Enter starts a new line. The screen is cleared on exit.

With a pipe on input or output, or `TERM=dumb`, `chat` uses a line view: one line in, plain text out. `--plain` forces it. Nothing forces the full screen. The line view has fewer commands, listed by its `/help`, and prints `session: <id>` on standard error when it ends.

### Web

```sh
minidsh web --cwd path/to/repo
```

It prints one URL. Opening it signs that browser in with a cookie and spends the link. The same browser can reopen it. The cookie dies with the process. Ctrl+C stops it.

The page can run commands on your machine, so who can reach it matters:

- It listens on `127.0.0.1`, on a free port. `--port <n>` fixes the port.
- `--host <addr>` listens elsewhere. There are no accounts and no TLS. Whoever opens the link first controls the agent.

More in [SECURITY.md](../SECURITY.md), including the cookie's scope.

### Desktop

The first start asks for a folder and offers a form for provider keys. Later, File > Open Folder and File > Provider Keys do the same. Started from a dock or menu on macOS or Linux, the app does not see your shell profile's variables, so save keys in the form. Closing the window quits, after asking if work would be interrupted.

### Headless and scripts

```sh
minidsh run "fix the failing test in src/slug.test.mjs" --approve
minidsh run "summarize this repository" --json
```

`run` does one task and exits. The answer goes to standard output. Progress and a last `session: <id>` line go to standard error. `--json` makes standard output one JSON object per event.

Exit code 0 means the turn completed. 1 means it did not: an error, a failed start, or the step limit (`--max-steps`, default 24). 2 means a bad command, flag or configuration file, and nothing ran.

Nobody can answer an approval here, so `run` refuses any call that needs one and prints a line naming the flag that would allow it. `--approve` answers every request yes. A turn can complete with a command refused, so exit 0 is no proof that everything ran.

`minidsh serve` speaks JSON-RPC on standard input and output, for a client you write: see the [protocol README](../src/capabilities/protocol/README.md).

## Approvals and the sandbox

Four settings decide what a session may do. The log records each one.

| Setting | Values | Set with |
|---|---|---|
| Sandbox mode | `read-only`, `workspace-write` (default: writes inside the working folder), `danger-full-access` | `--sandbox`, `/sandbox` |
| Approvals | `ask` (default) or `never`, which refuses every request unasked | `--ask`, `/ask` |
| Preset | `workspace-write` (with `ask`) or `danger-full-access` (with `never`) | `--preset` when headless, `/preset` |
| Acceptance | `full` (default) or `none`: run a shell that cannot be confined | `--accept`, `/accept` |

A flag wins over the same setting in `composition.json`. MiniDSH checks the editor tool's writes itself, and under `workspace-write` refuses one outside the folder without asking. The operating system confines shell commands:

- **Linux** (bubblewrap) and **macOS** (Seatbelt): commands run unasked. When one needs more than the mode allows, the model may ask to run it once in a wider mode, and you get an approval.
- **Windows**, and Linux without bubblewrap: the first shell command is refused with `SANDBOX_UNAVAILABLE`. The model then asks to run it under `danger-full-access`, and you are asked for each command. An approved command gets a fresh shell, so `cd` does not carry over.
- `--accept none` records that the session accepts an unconfined shell. Commands then run unasked in one persistent shell. Editor writes stay fenced. Shell commands can write anywhere your account can.

An approval shows the exact command and the mode it would run under, with the model's reason beside it. `y` allows once, `n` rejects. Where offered, `a` allows that identical call for the rest of this run of the session, until a setting changes or you revoke it (`/grants`, `/revoke <id>`). A resume or a fork asks again. In the full-screen terminal the keys arm after a moment, so typing ahead cannot answer. `--approve` on `chat`, `web` or `serve` answers every request yes, so nothing asks.

Confinement does not cover (details in [SECURITY.md](../SECURITY.md)):

- the network
- a service the command can reach: the system bus, a Docker socket, anything listening on localhost
- reads, `credentials.json` included
- a hard link in the workspace to a file outside it

## Sessions

A session is one append-only log, `~/.minidsh/sessions/<id>.jsonl`, written to disk before each model call and tool effect. It survives a killed process.

```sh
minidsh sessions list  # id, start time, folder, title
minidsh sessions show <id>  # every event, numbered
minidsh sessions show <id> --audit  # what it was allowed to do, what each call did
minidsh sessions verify <id>  # exit 0 if a resume would work
minidsh sessions inspect <id>  # runs, authority, grants, jobs, cost
minidsh resume <id>
minidsh fork <id> --at <seq>
```

- A failed start is listed too. No command deletes, renames or searches sessions.
- `verify` and `inspect` change nothing.
- `resume` continues a session in the terminal, and `fork` branches it into a new one. With `--headless` and a quoted task, both run as `run` does.
- `--at <seq>` may not fall inside a turn. The refusal names the nearest turn ends, and `sessions inspect` lists every one. Without `--at` the fork starts from the end. `fork <id> --salvage` branches a damaged log from its readable part. A fork is saved once you send it a message, and says so.

After a crash the next `resume` closes what was open and continues under the recorded authority. A tool call in flight is marked outcome unknown, a running job lost. One process holds a session at a time, and a second is refused with a message naming the holder. A holder that died on this machine is replaced by the next resume.

## Skills

A skill is a folder with a `SKILL.md`: instructions the model reads when a task fits. It grants no permission, and its scripts run as ordinary shell commands under the session's sandbox. MiniDSH looks in `~/.minidsh/skills/<name>/`, in the package's own skills, and in a repository's `.agents/skills/` and `.claude/skills/`. A repository's skill never replaces yours.

```sh
minidsh skills
```

It lists what a session in the current folder is offered and what was skipped. Two skills ship: `office` (create, read and edit .docx, .xlsx, .pptx) and `pdf` (read PDFs, write simple ones). They need only Node 24. More in [skills/README.md](../skills/README.md).

## Background jobs

The model can start a long command, such as a dev server or a slow test run, as a background job and keep working.

- See jobs with `/jobs` in the terminal or in the web UI's session panel. Stop one with `/jobs cancel <id>` or the panel's button.
- A job ends when you quit, when a `run` finishes, or when the sandbox mode or acceptance changes. What it started stops with it, except a process started through WMI or the Task Scheduler on Windows.
- If MiniDSH is killed, a job can outlive it on macOS, and on Linux when unconfined. The next resume reports it lost and leaves it running.
- On Windows a job needs `--accept none` or `danger-full-access`.

## Browser and web search

**Browser.** Where Chrome, Edge or Chromium is installed in a standard place, the model gets tools to open a page, read it, click and type, take a screenshot and run JavaScript. It reaches localhost, the workspace's files and any `allowHosts` named in the `tool-browser` row. It asks no approval, and it reaches every service listening on localhost. There is no tool that fetches a web page.

**Web search** is off until you add it. Save a Tavily key:

```sh
minidsh credentials set TAVILY_API_KEY
```

Then put this in `~/.minidsh/composition.json`:

```json
{ "patches": [{ "insert": [{ "id": "tool-web-search", "plugin": "tool-web-search" }] }] }
```

`minidsh config` then lists the row, marked `[!]` because it widens what a session can do. Every query asks first, showing the exact text that would leave the machine. A headless run searches only with `--approve`.

## Configuration

Everything lives under `~/.minidsh`, or under `MINIDSH_HOME` when set.

| Path | Holds |
|---|---|
| `sessions/` | one log per session. MiniDSH never deletes one. |
| `spill/` | oversized tool output, swept after 30 days |
| `attachments/` | images a session saw, never swept |
| `browser/` | throwaway browser profiles |
| `skills/` | your own skills |
| `credentials.json` | provider keys |
| `settings.json` | defaults for new sessions. The web UI's settings write it. |
| `composition.json` | which plugins run and how. Trusted like code. Read at start. `--patch <file>` adds a layer over it for one run. |
| `AGENTS.md` | optional instructions for every session, beside a repository's own `AGENTS.md` or `CLAUDE.md` |

An example `settings.json`:

```json
{ "agent": { "provider": "anthropic", "model": "claude-sonnet-5", "maxSteps": 40 } }
```

`agent` also takes `reasoningEffort`, `maxTokens`, `temperature` and `maxParallelToolCalls` (default 4). An unknown key is an error, and so is a file that is there and cannot be read. An empty file is read as no settings, with a warning. `minidsh config` prints the plugins in effect and which file changed each.

| Variable | Effect |
|---|---|
| `MINIDSH_HOME` | the data folder, in place of `~/.minidsh` |
| `MINIDSH_MODEL` | the model for new sessions. Beats `settings.json`, loses to `--model`. |
| `MINIDSH_ASCII` | `1` draws the full-screen terminal in ASCII, for a font that shows boxes or question marks |
| `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY` | keys. Each beats the stored one. |
| `DEEPSEEK_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | another endpoint for that provider (OpenAI's includes `/v1`) |
| `MINIDSH_DESKTOP_DATA` | desktop app: another folder for its settings and logs |
| `MINIDSH_DESKTOP_NODE`, `MINIDSH_DESKTOP_BIN` | desktop app from a checkout: its Node and CLI |

## Troubleshooting

| You see | What to do |
|---|---|
| `MISSING_CREDENTIAL`, `DeepSeek API key not set` | Run `minidsh credentials set DEEPSEEK_API_KEY`, or choose a provider whose key you have. |
| `UNKNOWN_MODEL`, `no provider "..." is mounted` | A wrong model or provider id. |
| `SANDBOX_UNAVAILABLE` | The system cannot confine the shell. See [Approvals and the sandbox](#approvals-and-the-sandbox). |
| `unavailable` or `SANDBOX_ESCALATION_DENIED` in `minidsh run` | Nobody could answer an approval. Pass `--approve`, or `--accept none` for an unconfined shell. |
| `install PowerShell 7 (pwsh)` | Windows ships 5.1 only. Install 7 ([npm](#npm)) and open a new terminal. |
| On Windows a command hangs until its time limit | It waits for input it cannot get. Ask for a non-interactive form. |
| `that link has already been used` | Another browser spent the link. Restart `minidsh web` for a new one. |
| `settings file ... is invalid`, `composition file ... is invalid` | Fix the named file. The command stopped before it started anything (`sessions`, `skills` and `credentials` only warn about `settings.json`). `composition.json` is an object holding a `patches` list, and a bare list is refused. |
| `the stored log is locked by pid ...` | Another MiniDSH has the session open. Remove the `.lock` file only if that process is gone and a resume still refuses. |

More limitations: [ARCHITECTURE section 13](ARCHITECTURE.md#13-known-limitations-current). Report a vulnerability as [SECURITY.md](../SECURITY.md) describes.
