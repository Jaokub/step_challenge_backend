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
    ];
    const offenders = [];
    for (const file of allFiles) {
      for (const key of retiredKeys) {
        if (file.content.includes(key)) {
          offenders.push(`${file.path} references retired i18n key "${key}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
