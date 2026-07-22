import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @module regression/points-invisible
 * @description BUILD_PLAN.md Phase 6A: "grep the mobile tree for
 * reintroduced pt/pts labels, PointsBadge usage, or +points toast copy" —
 * the cheap guard that stops a future change from silently undoing Phase 8
 * (points hidden, ranking is step-based everywhere). Lives in the backend
 * test suite because that's where the only test runner in the repo is —
 * it reads mobile/ source files but asserts nothing about the backend
 * itself. The "assert /leaderboard/* responses are ranked by steps" half of
 * this Phase 6A bullet is covered separately by leaderboard.service.test.js
 * (getGlobalLeaderboard/getFriendsLeaderboard/getGroupLeaderboard specs),
 * not duplicated here.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MOBILE_ROOT = resolve(__dirname, '../../../mobile');

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.expo', 'dist', 'build', 'ios', 'android']);

/** Recursively collect every source file under `dir`. */
const collectFiles = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // mobile/ not present in this checkout — caller handles the empty list
  }
  const files = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (CODE_EXTENSIONS.has(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
};

const readAll = (files) => files.map((f) => ({ path: f, content: readFileSync(f, 'utf8') }));

describe('regression — points stay invisible in the mobile app (Phase 8 guard)', () => {
  const allFiles = readAll(collectFiles(MOBILE_ROOT));

  it('sanity check: the mobile tree is actually reachable from this checkout', () => {
    // If this fails, every other test in this file is vacuously "passing"
    // for the wrong reason (nothing to scan) — fail loudly instead.
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('no JSX usage of <PointsBadge> outside its own (unreferenced-by-design) definition file', () => {
    const offenders = allFiles
      .filter((f) => !f.path.endsWith(`${'PointsBadge'}.tsx`))
      .filter((f) => /<PointsBadge\b/.test(f.content))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('no "+points" / "+X points" toast or badge copy in the check-in flow', () => {
    const checkinFlowFiles = allFiles.filter((f) =>
      /[\\/](scan|attendees)\.tsx$/.test(f.path)
    );
    expect(checkinFlowFiles.length).toBeGreaterThan(0); // guard against the glob silently matching nothing

    const offenders = checkinFlowFiles
      .filter((f) => /\+\s*\$?\{?[\w.]*points|points?Awarded.*toast|\+\d+\s*points/i.test(f.content))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('no code path actually CALLS the retired goal-reached/points-badge i18n keys (dead JSON entries are fine, live t() usage is not)', () => {
    // Phase 8's shipped notes list "no goal-reached toast, no ได้แต้มแล้ว/
    // ยังไม่ถึงเป้า badge" as removed from scan.tsx/attendees.tsx. The i18n
    // keys themselves are allowed to remain as dead JSON entries (repo
    // convention), but no .ts/.tsx/.js/.jsx file should still call
    // t('scan.goalReached'), t('admin.pointsAwardedBadge'), etc. — that
    // would mean the copy is actually reachable again, not just present in
    // a locale file no one references.
    // NOTE: only keys with zero remaining code references belong here. The
    // admin activity form deliberately still uses `admin.activityType*` /
    // `admin.expectedStepsRequired` (Phase 8 left the admin-only step-goal
    // config in place), so those are NOT retired and must not be listed.
    const retiredKeys = [
      'scan.goalReached',
      'scan.walkToEarnHint',
      'scan.pointsEarned',
      'admin.pointsAwardedBadge',
      'admin.pointsPendingBadge',
      'admin.manualCheckinSuccessPoints',
      // Deleted 2026-07-20 along with the admin points form field and the two
      // screens that were rendering real point numbers.
      'admin.activityPoints',
      'admin.egPoints',
      'admin.pointsShort',
      'groups.totalPointsStat',
      'activity.metaPoints',
      'activity.points',
      'common.points',
      'common.pts',
    ];
    // Match the key only where it appears as a QUOTED string — i.e. how it
    // would be written in a t('...') call. A bare substring match produces
    // false positives against ordinary property access: `activity.points` is
    // both an i18n key and a real field on the Activity type.
    const offenders = [];
    for (const file of allFiles) {
      for (const key of retiredKeys) {
        const quoted = new RegExp(`['"\`]${key.replace(/\./g, '\\.')}['"\`]`);
        if (quoted.test(file.content)) {
          offenders.push(`${file.path} references retired i18n key "${key}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The locale files are where user-facing copy actually lives, and the guard
 * above never looked at them: `collectFiles` only walks .ts/.tsx/.js/.jsx.
 *
 * That blind spot let real points copy ship. On 2026-07-20 the locale files
 * still held 21 strings containing points vocabulary, 11 of them reachable —
 * including a stat card rendering a live `totalPoints` figure on the group
 * overview screen and a "{{points}} pt" chip on activity detail.
 *
 * The deeper problem was the shape of the check, not just its file filter:
 * `retiredKeys` above is a hand-maintained DENYLIST, so any points string not
 * on the list passes. Adding .json to that same denylist would have missed
 * them too.
 *
 * So this block inverts it. It scans every locale VALUE for points vocabulary
 * and fails by default. New points copy has to be added to ALLOWED_KEYS with
 * a written reason, which makes reintroducing it a deliberate act rather than
 * an accident.
 */
describe('regression — no points vocabulary in the mobile locale files', () => {
  const LOCALES_DIR = resolve(MOBILE_ROOT, 'src/i18n/locales');

  // Thai and English words for points. `\b` keeps "pt"/"pts" from matching
  // inside unrelated words, and avoids flagging e.g. "checkpoint".
  const POINTS_VOCAB = /แต้ม|คะแนน|\bpoints?\b|\bpts?\b/i;

  /**
   * Keys permitted to mention points despite the rule above.
   * Empty on purpose. Adding an entry requires a comment saying why the copy
   * is correct — e.g. an admin-only screen that genuinely exposes the dormant
   * ledger. "It was already there" is not a reason.
   */
  const ALLOWED_KEYS = [];

  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === 'object' && value !== null
        ? flatten(value, path)
        : [[path, value]];
    });

  const localeFiles = (() => {
    try {
      return readdirSync(LOCALES_DIR)
        .filter((f) => extname(f) === '.json')
        .map((f) => ({ name: f, json: JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8')) }));
    } catch {
      return [];
    }
  })();

  it('sanity check: the locale files are actually reachable and non-trivial', () => {
    // Without this, a wrong path would make every assertion below pass by
    // scanning nothing — the exact failure mode that hid the bug.
    expect(localeFiles.length).toBeGreaterThan(0);
    for (const { name, json } of localeFiles) {
      expect(flatten(json).length, `${name} looks empty`).toBeGreaterThan(100);
    }
  });

  it('no locale string mentions points, in any language', () => {
    const offenders = [];
    for (const { name, json } of localeFiles) {
      for (const [key, value] of flatten(json)) {
        if (typeof value !== 'string') continue;
        if (ALLOWED_KEYS.includes(key)) continue;
        if (POINTS_VOCAB.test(value)) {
          offenders.push(`${name} → ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every locale file has the same key set, so a fix in one language cannot be forgotten in another', () => {
    // A points string removed from Thai but left in English would still be
    // shown to anyone running the app in English.
    if (localeFiles.length < 2) return;
    const [first, ...rest] = localeFiles;
    const baseline = flatten(first.json).map(([k]) => k).sort();
    for (const other of rest) {
      const keys = flatten(other.json).map(([k]) => k).sort();
      expect(keys, `${other.name} differs from ${first.name}`).toEqual(baseline);
    }
  });
});
