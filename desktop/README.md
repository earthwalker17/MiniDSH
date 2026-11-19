# MiniDSH desktop

The installable app: one window over the same `minidsh` runtime and Web UI the CLI ships. It is a surface (ARCHITECTURE §8), not a second runtime. The window runs the bundled CLI's `minidsh web --json` on a bundled Node and shows the unmodified Web UI.

## Build it

```sh
pnpm install                       # at the repository root
pnpm --dir desktop install         # electron-builder, for packaging only
node desktop/scripts/package.ts    # this host's installer: Windows NSIS, Linux AppImage, macOS zip
node desktop/scripts/package.ts --dir   # the unpacked app only (faster)
```

The output lands in `desktop/build/dist/`. Windows builds are unsigned unless `WIN_CSC_LINK` (or `CSC_LINK`) and its password are in the environment. macOS builds are ad-hoc signed unless a Developer ID is configured. Every other gate (`pnpm check`) covers `desktop/src` without this install.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Electron main: wiring only — window, overlay, lifecycle, menus |
| `src/*.ts` | Electron-free modules, unit-tested under plain Node: runtime supervision, wire inspection, settings, folder admission, menus, credentials, update check |
| `src/preload.cjs` | the shell overlay's API (never the Web UI's) |
| `shell/` | the overlay's page: starting, welcome, keys, stopping, stopped |
| `scripts/package.ts` | stages the runtime (`pnpm pack` → npm install), the pinned Node and the app, then runs electron-builder |
| `installer.nsh` | the NSIS hook that refuses to install or uninstall while MiniDSH runs |
| `resources/` | the icon (from the mark in `shell/mark.svg`) |
