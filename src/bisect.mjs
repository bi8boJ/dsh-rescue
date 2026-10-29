export const DEFAULT_BISECT_ROUND_SECONDS = 60;

/**
 * Bisect which plugin is keeping DSH from booting.
 *
 * The loop only needs one fact per round: "with this subset loaded, does it
 * boot?" The caller supplies that (`test`), so the search itself stays pure and
 * testable — in the CLI it is wired to a real guarded launch.
 *
 * Assumption, stated in the output: exactly one culprit. With several broken
 * plugins this converges on one of them.
 */
export async function runBisect({
  bundles,
  isCandidate = () => true,
  test,
  maxRounds = 14,
  onRound = () => {},
} = {}) {
  if (typeof test !== 'function') throw new Error('runBisect: test is required');
  const all = Array.isArray(bundles) ? bundles.slice() : [];
  const candidates = all.filter((name) => isCandidate(name));
  const rounds = [];

  const record = (entry) => {
    rounds.push(entry);
    onRound(entry);
  };

  if (candidates.length < 2) {
    return { ok: false, reason: 'too-few-candidates', candidates, culprit: null, rounds };
  }

  const fullOk = await test(candidates);
  record({ phase: 'baseline-full', members: candidates, ok: fullOk });
  if (fullOk) {
    return { ok: false, reason: 'baseline-boots', candidates, culprit: null, rounds };
  }

  const bareOk = await test([]);
  record({ phase: 'control-bare', members: [], ok: bareOk });
  if (!bareOk) {
    return { ok: false, reason: 'without-candidates-also-fails', candidates, culprit: null, rounds };
  }

  let good = [];
  let suspects = candidates.slice();
  while (suspects.length > 1) {
    if (rounds.length > maxRounds + 2) {
      return { ok: false, reason: 'round-limit', candidates, culprit: null, suspects, rounds };
    }
    const mid = Math.ceil(suspects.length / 2);
    const trial = suspects.slice(0, mid);
    const members = [...good, ...trial];
    const ok = await test(members);
    record({ phase: 'bisect', members, suspects: suspects.slice(), ok });
    if (ok) {
      good = members;
      suspects = suspects.slice(mid);
    } else {
      suspects = trial;
    }
  }

  return { ok: true, reason: 'found', culprit: suspects[0] ?? null, suspects, candidates, rounds };
}