# MiniDSH desktop

A launcher around the web host the CLI ships. Electron's main process spawns the bundled CLI's `minidsh web --json` on a bundled Node, reads its `ready` record from stdout, trades the one-shot token for a cookie, and shows the unmodified Web UI in one window. It imports nothing from `src/`: `scripts/check-deps.ts` holds `desktop/src` to `electron`, `node:*` and itself. The contract is the desktop paragraph of [ARCHITECTURE section 8](../docs/ARCHITECTURE.md#8-surfaces).

To install and use the app, see [the guide](../docs/GUIDE.md#desktop-app).

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Electron main: the window, the shell overlay, the lifecycle, the menus |
| `src/*.ts` | Electron-free rules, unit-tested under Node: `runtime.ts` (the child's argv, records and stop), `inspect.ts` (asks the runtime whether work is running), `folders.ts` (folder admission) and smaller ones |
| `src/preload.cjs` | the overlay's API. The Web UI's view has no preload |
| `shell/` | the overlay's pages: starting, welcome, keys, stopping, stopped |
| `scripts/` | `package.ts` stages the runtime, a pinned Node and the app, then runs electron-builder. `smoke-runtime.ts` starts the packaged runtime with no window |
| `e2e/` | `app.e2e.test.ts` drives the packaged app with no key. `live.e2e.test.ts` drives the installed app on a real model, on Windows |
| `resources/` | the icon |
| `release-assets.json` | the installer's file name per platform |
| `installer.nsh` | the NSIS hook that refuses to install or uninstall while the app runs |

## Build and test

```sh
pnpm install                            # at the repository root
pnpm --dir desktop install              # electron-builder
node desktop/scripts/package.ts         # this host's installer
node desktop/scripts/package.ts --dir   # the unpacked app only
node desktop/scripts/smoke-runtime.ts <the app's resources directory>
```

Output goes to `desktop/build/dist/`. On Windows the resources directory is `desktop/build/dist/win-unpacked/resources`.

`pnpm test` at the root runs `desktop/src/*.test.ts`, and `pnpm check` covers `desktop/src` without the desktop install. The app suite needs `MINIDSH_DESKTOP_EXE` set to the built executable (`desktop/build/dist/win-unpacked/MiniDSH.exe`, on Linux `linux-unpacked/minidsh-desktop`) and skips without it:

```sh
npx vitest run --config vitest.e2e.config.ts desktop/e2e/app.e2e.test.ts
```

## What it does not do

- It does not update itself. Help, Check for Updates asks GitHub for the latest release and offers its page when that release is newer (`src/update.ts`).
- It carries no publisher signature by default. Windows builds are signed only when `CSC_LINK` or `WIN_CSC_LINK` is set. macOS builds are ad-hoc signed unless `CSC_LINK` or `CSC_NAME` names a certificate, and are never notarized.
- The launcher passes no authority flag to the runtime (`src/runtime.ts`). A person switches authority in the Web UI.
- It has no tray. Closing the window quits, after a confirm when the runtime reports work in progress.

The remaining gaps are under Surfaces in [section 13](../docs/ARCHITECTURE.md#13-known-limitations-current).

## Relation to DeepSeek Harness

The upstream counterpart is `apps/desktop` with `apps/desktop-host` and `packages/host/authentication-desktop`. Both are Electron shells over the project's web host. DSH runs its host as an Electron RunAsNode child over Node IPC behind a `dsh-app://` scheme, hides to the tray on Windows, and ships an update feed for signed builds. MiniDSH runs an official Node with RunAsNode off, reads a `ready` line, and points at a release page.

MiniDSH's app is the smaller one. It bundles Node alone, where DSH's also carries Python and pnpm as a signed payload. It does not read the login shell's environment on macOS and Linux, which DSH does. The reasons are in [section 12](../docs/ARCHITECTURE.md#12-divergences-from-deepseek-harness-the-ones-that-still-shape-decisions).
