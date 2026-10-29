# dsh-rescue

Rescue a DeepSeek Harness (DSH) install that no longer starts — or crashes on start — because of plugin conflicts, **without losing the state that still worked**.

A zero-dependency Node CLI that runs *outside* the app, because when DSH cannot boot, anything installed inside DSH cannot boot either.

```console
$ dsh-rescue rescue
Rolling back to 20261029T101010123Z-9f3e (marked good 2 hours ago)
Confirm? The current state is snapshotted first. [y/N] y
Done: restored 20261029T101010123Z-9f3e
Wrote      profiles/desktop/package.json, profiles/desktop/cordis.patch.yml
Pre-state  20261029T154130001Z-77ab
Undo       dsh-rescue restore 20261029T154130001Z-77ab

What the broken state looked like, relative to the last good one:
  added bundle: dsh-some-new-plugin
  dependency changed: dsh-better-sidebar ^0.28.0 -> ^0.29.0
  patch gained id: llm-pi-ai
  all of the above has been reverted.

Verify: current config is byte-identical to good ✓
```

## Why this exists

DSH ships half a rescue, and that half has two holes (both readable in `app.asar`):

**1. The built-in "disable third-party plugins" is an irreversible sledgehammer.**
On a fatal host failure DSH shows a native dialog; its third button calls `sanitizeProfile()`: rename `cordis.patch.yml` to `.bak-<ms>`, then **overwrite** `dsh.profile.bundles` in `package.json` with the shipped template.
The `.bak` only preserves the patch file — **there is no backup of "which plugins were enabled, in what order"**. You are rescued, but not restored.

**2. It cannot rescue the real "won't open" case.**
`DesktopHostProcess.start()` awaits a `ready` IPC message or process exit with **no timeout**. When a plugin hangs inside `apply()` (infinite loop, an `await` that never settles, a service that never appears), Electron waits forever: no window, no crash report, and the recovery dialog never appears.

**3. An empty patch file is worse than a broken one.**
`dsh-app-boot` documents that an empty or comments-only `cordis.patch.yml` **fails boot** — to disable the layer you must write `[]`. So "just clear it" is a way to make things worse.

dsh-rescue closes those three gaps: reversible, works for the hang case, never writes an empty patch.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/<you>/dsh-rescue.git
node dsh-rescue/bin/dsh-rescue.mjs status

# or
npm install -g .

# Windows: double-click bin\dsh-rescue.cmd for the interactive menu.
# It finds node on PATH, and falls back to the runtime DSH ships.
```

Machines with DSH often have no `node` on `PATH` (DSH bundles one but does not export it). Both launchers probe the usual locations; `DSH_RESCUE_NODE` overrides.

## Quick start

```bash
# 1. While DSH works, record that this state is good
dsh-rescue good

# 2. The day it stops starting (or starts but is clearly wrong)
dsh-rescue status     # static checks + latest crash + drift from the good state
dsh-rescue rescue     # snapshot the broken state, roll back, report, verify

# No good snapshot yet? Use the reversible safety net first
dsh-rescue safe-mode  # keep only shipped bundles
dsh-rescue undo       # withdraw it once you are back in
```

## Commands

| Command | What it does |
|---|---|
| `status` | Checks + latest crash facts + drift from the last good state |
| `doctor` | Static checks only; exit code 1 on errors (CI friendly) |
| `good` | Mark the current state as known-good (refuses when checks fail) |
| `save` | Plain snapshot, for taking a point before touching plugins |
| `rescue` | Snapshot → restore last good → report what was reverted → verify |
| `restore <ref>` | Restore any snapshot (`last`, `good`, full id, or id prefix) |
| `safe-mode` | Keep only `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` |
| `undo` | Revert the last write via the pre-state snapshot in the journal |
| `list` | Snapshot list with the good pointer marked |
| `diff [a] [b]` | Difference between two states, default `good → current` |
| `crash` | Parse the latest crash report: exit code, skipped bundles, version mismatches, entries stuck waiting for a service |
| `menu` | Interactive menu (the `.cmd` default) |

Options: `--home`, `--profile`, `--runtime`, `--json`, `--yes`, `--dry-run`, `--force`.

The runtime version is read straight out of the installed `app.asar` (the same manifest DSH itself consults for its compatibility gate), so `dsh` does not need to be on `PATH`. If it cannot be found — an unusual install location — pass `--runtime <version>`, otherwise the version-gate check is skipped.

## Safety guarantees

- Every write is preceded by a pre-state snapshot — the broken state is never destroyed.
- Files that exist now but were absent in the snapshot are renamed to `.pre-<stamp>`, never deleted.
- Restore re-hashes the result and says so if anything still differs.
- Refuses to write while DSH is running (`dsh-hmr` would hot-apply it); `--force` overrides.
- Refuses to restore a snapshot that is itself incomplete or whose `package.json` is not valid JSON.
- YAML is appended to line by line; comments and `!!js` expressions survive untouched. Disabling a layer writes `[]`, never an empty file.

## Where snapshots live

```
<DSH_HOME>/rescue/
  snapshots/<id>/snapshot.json   metadata (bundles, per-file hashes)
  snapshots/<id>/installed.json  installed packages and versions
  snapshots/<id>/files/...       the five config files, verbatim
  good.json                      points at the last good snapshot
  journal.json                   last 50 write operations
```

30 non-good snapshots are kept by default; good ones are never pruned (`--retention`).

## Non-goals

- No process supervision or watchdog (v0.2).
- No touching `node_modules`, no installing, no network.
- No touching sessions, workspaces, or memories — only the five plugin config files.
- No YAML re-serialisation, and no guessing: an existing entry without `disabled: true` is reported, not rewritten.

## Platform support

Windows is the tested platform. macOS/Linux paths and crash-log locations are implemented but **unverified on hardware** — issues welcome.

Crash logs are looked up in both:
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs` (or the macOS/Linux equivalent)
- `<DSH_HOME>\electron-user-data\logs` (used by DSH NEXT)

## Development

```bash
node --test                                            # 145 tests, all on synthetic homes
DSH_REAL_HOME=1 node --test test/real-smoke.test.mjs   # two extra read-only checks on the real home
```

Design notes: [docs/design.md](docs/design.md).

## License

MIT