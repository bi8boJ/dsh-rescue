/**
 * Boot watchdog: start the app, wait for it to actually become usable, and if
 * it never does, kill it, restore the last good configuration and try once more.
 *
 * DSH's own recovery cannot cover this case: `DesktopHostProcess.start()` waits
 * for a `ready` IPC message with no timeout, so a plugin that hangs inside
 * `apply()` leaves the app with no window and no dialog — nothing to click.
 *
 * Everything with a side effect is injected, so the whole state machine is
 * exercised in tests without spawning anything.
 */
export async function runLaunchWatchdog({
  launch,
  probeReady,
  isExited = null,
  sleep,
  now = () => Date.now(),
  bootTimeoutMs = 90_000,
  intervalMs = 1_000,
  maxAttempts = 2,
  onFailure = null,
  log = () => {},
} = {}) {
  if (typeof launch !== 'function') throw new Error('launch is required');
  if (typeof probeReady !== 'function') throw new Error('probeReady is required');
  if (typeof sleep !== 'function') throw new Error('sleep is required');

  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = now();
    log({ type: 'launch', attempt, timeoutMs: bootTimeoutMs });
    let app;
    try {
      app = launch({ attempt });
    } catch (error) {
      const failure = { ok: false, reason: 'launch-failed', message: error.message, attempt, elapsedMs: 0 };
      attempts.push(failure);
      return { ok: false, attempts, ...failure };
    }

    let outcome = null;
    for (;;) {
      if (probeReady({ attempt, pid: app.pid })) {
        outcome = { ok: true, reason: 'ready', elapsedMs: now() - startedAt, pid: app.pid };
        break;
      }
      if (isExited && isExited({ attempt, pid: app.pid })) {
        outcome = { ok: false, reason: 'exited', elapsedMs: now() - startedAt, pid: app.pid };
        break;
      }
      if (now() - startedAt >= bootTimeoutMs) {
        outcome = { ok: false, reason: 'timeout', elapsedMs: now() - startedAt, pid: app.pid };
        break;
      }
      await sleep(intervalMs);
    }

    if (outcome.ok) {
      attempts.push({ ...outcome, attempt });
      return { ok: true, attempts, ...outcome };
    }

    log({ type: 'failure', attempt, reason: outcome.reason, elapsedMs: outcome.elapsedMs });
    let killed = false;
    // A process that already exited needs no killing.
    if (outcome.reason !== 'exited' && typeof app.kill === 'function') {
      try {
        app.kill();
        killed = true;
      } catch (error) {
        log({ type: 'kill-failed', attempt, message: error.message });
      }
    }

    let restored = null;
    if (typeof onFailure === 'function') {
      try {
        restored = await onFailure({ ...outcome, attempt, killed });
      } catch (error) {
        restored = { ok: false, message: error.message };
        log({ type: 'restore-failed', attempt, message: error.message });
      }
    }

    attempts.push({ ...outcome, attempt, killed, restored });
    if (attempt === maxAttempts) {
      return { ok: false, attempts, ...outcome, killed, restored };
    }
  }

  return { ok: false, attempts, reason: 'exhausted', elapsedMs: 0 };
}