# Pictures

What each file in this folder is and how to make it again. `scripts/check-docs.ts` fails on a picture here that no document shows or lists, and on a document that shows one that is missing.

## Screenshots

Every screenshot shows a real session. None is drawn, retouched or recompressed, and the session three of them share is in this folder: `logs/tinytable-fix.jsonl`, one turn of `deepseek-flash` fixing a failing test in a twenty-line scratch project (`scripts/shots/project.sh`), recorded on 2026-11-21 with `minidsh run` under bubblewrap. The model's first edit was refused because it had not read the file, and the log keeps that.

| File | What it shows | How it was taken |
|---|---|---|
| `web-light.png`, `web-dark.png` | the web UI on that session, the finished turn's work opened to the edit's diff | `scripts/capture-shots.ts` against a keyless host serving the log, 1280×800 at twice the density |
| `approval.png` | an approval waiting to be answered | the same tool against a live host and a real key: the model was asked to save the test output outside the working folder, which the sandbox does not allow, so it asked to run that one command unconfined |
| `terminal.png` | the full-screen terminal on that session | a real Windows Terminal window, captured with `PrintWindow` (`scripts/shots/Capture-Terminal.ps1`) |
| `desktop.png` | the desktop app in its own window, after the same task done live on Windows, where each shell command is approved by a click | the installer CI built for the release candidate, installed, driven and captured by `scripts/shots/capture-desktop.ts` |

All were taken on version 2.0.0.

### Taking them again

The pictures must not show a person's name, a home path or a key, and neither may a log that is published with them. So the runtime is run from neutral paths: as root under WSL 2, from `/opt/minidsh`, on a project in `/opt/minidsh-shots`. `scripts/shots/` holds the steps:

```sh
git archive --format=tar -o head.tar HEAD      # in the repository
bash scripts/shots/snapshot.sh head.tar        # as root in WSL: the tree at /opt/minidsh with its own install
bash scripts/shots/serve.sh recorded docs/images/logs/tinytable-fix.jsonl   # a keyless host; prints a one-time link
node scripts/capture-shots.ts --url <the link> --out docs/images --name web \
     --session "second test" --click "Ran commands, edited" --click "Edit filesrc/table.js" --show ".diff"
```

- `scripts/shots/Run-Capture.ps1` does the last two steps from Windows, with a fresh host for each capture.
- `scripts/shots/serve.sh live` serves a fresh copy of the project with a real key, for the approval picture (`--prompt`, `--until approval`).
- `scripts/shots/tui.sh <log>` opens the log in the full-screen terminal, for `Capture-Terminal.ps1`.
- `scripts/shots/capture-desktop.ts` starts an installed app with a data folder and a home of its own, gives it the task, clicks each approval, and captures its window when the turn is over.
- `scripts/shots/record.sh <directory>` records a new session, and `scripts/shots/scan.mjs <log>` fails on a log that holds a key, a user name, a host name or a home path. Scan before publishing a log.

## Logo

`logo/` holds the mark for listings and launch pages. The drawing is the one the app uses: `scripts/logo.test.ts` holds its geometry equal in every place it is written.

| File | What |
|---|---|
| `logo/minidsh-logo.svg` | the mark on a full-bleed square. Use this where the site rounds the corners itself. |
| `logo/minidsh-logo-1024.png`, `logo/minidsh-logo-512.png`, `logo/minidsh-logo-240.png` | the same, rendered at 1024, 512 and 240 px |
| `logo/minidsh-mark.svg` | the rounded tile on a transparent ground, byte for byte the desktop app's icon |
| `logo/minidsh-mark-1024.png` | the same, at 1024 px |
| `social-preview.svg`, `social-preview.png` | the repository's social preview, 1280×640: the mark, the name and one line. GitHub takes it as an upload in the repository's settings. |

The PNGs were rendered from the SVGs with a headless browser at the size in the name. Colours: ground `#0f1115`, stroke `#ffffff`, dot `#3cc2b0`.

## The hero

`README_hero.png` opens the README. It is a drawn image, not a screenshot, and its path is kept: the npm page and older links point at it.
