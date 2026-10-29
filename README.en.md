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

**4. The desktop app and DSH NEXT share one profile.**
NEXT writes `dsh.desktopNext*` keys into the same `package.json`, adds `desktop-next.*.patch.json` overlays, and ships its own bundles (`dsh-community-market`, `@agents-anywhere/dsh-bridge-next`).
Running both at once means two hosts, two HMR watchers and two live instances of every plugin, all writing the same state files — that is what "plugins fighting over files" looks like. The recovery button also writes config while the other instance is still using it.

dsh-rescue closes those four gaps: reversible, works for the hang case, never writes an empty patch, and knows about NEXT.

## Using it alongside DSH NEXT

- **Run one app at a time.** `doctor` reports `instances.dualHome` when both are up.
- **Close both before rescuing.** Otherwise the tool refuses to write (`--force` overrides).
- Bundles are resolved across both archives, so NEXT's built-in ones are not reported as missing.
- Restoring an older snapshot may drop NEXT's `desktopNext*` keys — `rescue` says so; NEXT usually re-adds them on the next launch, but the bundle order can change.
- Unusual install locations (e.g. `D:\deepseek harness\DSH NEXT`) usually need nothing: the tool recovers the path from the overlay NEXT wrote into the profile, and `--asar <path>` is there when that fails.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/bi8boJ/dsh-rescue.git
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
| `launch` | Watchdog boot: if it is not ready within N seconds, kill it, roll back, retry once |
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

Options: `--home`, `--profile`, `--runtime`, `--asar`, `--app`, `--boot-timeout`, `--round-timeout`, `--no-auto-restore`, `--json`, `--yes`, `--dry-run`, `--force`.

The runtime version is read straight out of the installed `app.asar` (the same manifest DSH itself consults for its compatibility gate), so `dsh` does not need to be on `PATH`. If it cannot be found — an unusual install location — pass `--runtime <version>`, otherwise the version-gate check is skipped.

## Protected boot (watchdog)

`rescue` needs you to notice that the app will not open. But one failure mode produces **no dialog at all**: a plugin hangs inside `apply()`, the host never reports ready, and Electron waits forever — no window, no crash report, nothing to click.

`launch` covers exactly that:

```bash
dsh-rescue launch                     # not ready within 90s = hung
dsh-rescue launch --boot-timeout 120
dsh-rescue launch --no-auto-restore   # kill only, do not roll back
```

It starts DSH, polls once a second for "is the app actually listening and serving on loopback?", and on timeout kills the whole process tree (`taskkill /T`), rolls back to the last `good`, and starts once more. If that also fails it stops and tells you what to do next — it never loops forever.

To use it every day, point your desktop shortcut at:

```
"...\dsh-rescue\bin\dsh-rescue.cmd" launch
```

(Double-clicking `bin\dsh-rescue.cmd` without arguments still opens the menu; `launch` is its first entry.)

Two caveats:

- It refuses to start a second instance — a watchdog only makes sense for a cold start.
- "Ready" means "a DSH process is listening on loopback". That is the most reliable signal available from outside; if you know a better one, `--boot-timeout` is there to tune the wait.

## Finding the culprit (bisect)

Being rescued is only half the story. `bisect` finds out who broke it:

```bash
dsh-rescue bisect              # close DSH first
dsh-rescue bisect --round-timeout 45 --yes
```

It first establishes two controls — "the current set really does fail" and "only the baseline bundles really does boot" — then loads half the suspects at a time, starting and stopping DSH once per round, halving the range each time. Four suspects take two or three rounds.

Hard rules:

- **It always puts your original `dsh.profile.bundles` back**, including when a round throws (`finally`).
- Refuses to run while DSH is up: it needs to start and kill the app repeatedly.
- It assumes **one** culprit. With several, it converges on one of them; close that and run it again.
- If even "all third-party off" fails to boot, it says so and points at `crash` / `doctor` instead.

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
node --test                                            # 202 tests, all on synthetic homes
DSH_REAL_HOME=1 node --test test/real-smoke.test.mjs   # two extra read-only checks on the real home
```

Design notes: [docs/design.md](docs/design.md).

## License

MIT