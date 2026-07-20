/**
 * @module HealthSyncService
 * @description Domain service for syncing health records and awarding points.
 * Encapsulates the upsert + points transaction logic that was duplicated across
 * the syncHealthData and syncFromWebhook controller handlers.
 */
import prisma from '../config/prisma.js';
import pointsService from './points.service.js';
import { calculateCheckInStreak } from './streak.service.js';
import { applyPoints } from './pointsLedger.service.js';
// ADR-001 / BUILD_PLAN.md Phase 7 — the ONLY hook this frozen file gets for
// step-gated activity points. All real logic lives in
// activityAward.service.js; this is a single call after the record upsert.
import { evaluateActivityAwardsForDate } from './activityAward.service.js';

/**
 * @typedef {Object} HealthMetrics
 * @property {number|undefined} steps
 * @property {number|undefined} calories
 * @property {number|undefined} distanceKm
 * @property {number|undefined} activeMinutes
 */

/**
 * Sync a single health record for a user and update their points atomically.
 * Uses an upsert keyed on [userId, recordDate, source].
 *
 * @param {string} userId
 * @param {Date} normalizedDate - UTC-normalised date (no time component).
 * @param {string} source - One of GOOGLE_HEALTH | APPLE_HEALTH | MANUAL.
 * @param {HealthMetrics} metrics
 * @returns {Promise<{record: Object, awardedActivityIds: string[]}>}
 *   `record` is the upserted health record; `awardedActivityIds` are any
 *   step-gated activities newly paid out by this sync (ADR-001 Phase 7).
 */
export const syncHealthRecord = async (userId, normalizedDate, source, metrics) => {
  // Drop unusable values before anything reads them — see sanitizeMetrics.
  const { steps, calories, distanceKm, activeMinutes } = sanitizeMetrics(metrics);

  // Streak lookup stays outside the transaction (read-only, non-critical).
  const currentStreak = await calculateCheckInStreak(userId);

  // Read-compute-write happens inside ONE transaction so two concurrent
  // syncs can't both read the same "old" record and double-award the delta.
  return prisma.$transaction(async (tx) => {
    const existingRecord = await tx.healthRecord.findUnique({
      where: { userId_recordDate: { userId, recordDate: normalizedDate } },
    });

    const oldMetrics = {
      steps: existingRecord?.steps || 0,
      calories: existingRecord?.calories || 0,
      distanceKm: existingRecord?.distanceKm || 0,
    };

    const newMetrics = {
      steps: steps !== undefined ? steps : oldMetrics.steps,
      calories: calories !== undefined ? calories : oldMetrics.calories,
      distanceKm: distanceKm !== undefined ? distanceKm : oldMetrics.distanceKm,
    };

    const deltaPoints = pointsService.calculatePointsDelta(oldMetrics, newMetrics, currentStreak);

    const upserted = await tx.healthRecord.upsert({
      // Keyed on [user, day] only — a user has at most ONE health row per
      // day regardless of which device reported it. When the key included
      // `source`, a day could hold a GOOGLE_HEALTH row AND a MANUAL row, and
      // every consumer then disagreed about what that day's step count was:
      // `aggregateByDate` and the leaderboard SUMMED the rows (inflating the
      // figure a user is ranked on) while `activityAward.dailyMaxSteps` took
      // the MAX. Collapsing to one row per day makes all three agree by
      // construction rather than by convention.
      where: { userId_recordDate: { userId, recordDate: normalizedDate } },
      update: {
        steps: steps !== undefined ? steps : undefined,
        calories: calories !== undefined ? calories : undefined,
        distanceKm: distanceKm !== undefined ? distanceKm : undefined,
        activeMinutes: activeMinutes !== undefined ? activeMinutes : undefined,
        // Record which device most recently reported this day. Last writer
        // wins, consistent with how a repeat sync from the SAME source has
        // always behaved (it replaces the day's figures rather than adding
        // to them, including downward corrections).
        source,
        createdAt: new Date(),
      },
      create: {
        userId,
        recordDate: normalizedDate,
        source,
        steps: steps || 0,
        calories: calories || 0,
        distanceKm: distanceKm || 0,
        activeMinutes: activeMinutes || 0,
      },
    });

    await applyPoints(tx, {
      userId,
      amount: deltaPoints,
      reason: 'HEALTH_SYNC',
      effectiveDate: normalizedDate,
      refId: source,
    });

    // Step-gated activity points (ADR-001): re-evaluate any unpaid,
    // step-gated CheckIn whose window contains this date now that fresh
    // steps have landed. Runs inside this same transaction so an award can
    // fire atomically with the sync that earned it. The returned ids are
    // passed straight through to the caller (health.controller.js) — PR 2's
    // foreground polling reads them to fire a celebration toast without a
    // separate request. No new decision logic added to this frozen file.
    const awardedActivityIds = await evaluateActivityAwardsForDate(userId, normalizedDate, tx);

    return { record: upserted, awardedActivityIds };
  });
};

/**
 * Aggregate health records by date.
 *
 * Since the [user, day] unique key there is now at most one row per day, so
 * this no longer combines anything across sources — the summing below is
 * effectively a pass-through and is kept only so a stray duplicate (e.g. a
 * row predating the dedupe migration) doesn't silently disappear from a
 * chart. It must NOT be relied on to merge sources: that summing was the
 * step-inflation bug this key change removed.
 *
 * @param {Array<Object>} records - Array of health records from Prisma.
 * @returns {Object} Map of date string → aggregated metrics.
 */
export const aggregateByDate = (records) => {
  const byDate = {};
  for (const record of records) {
    const dateKey = record.recordDate.toISOString().split('T')[0];
    if (!byDate[dateKey]) {
      byDate[dateKey] = { steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 };
    }
    byDate[dateKey].steps += record.steps || 0;
    byDate[dateKey].calories += record.calories || 0;
    byDate[dateKey].distanceKm += record.distanceKm || 0;
    byDate[dateKey].activeMinutes += record.activeMinutes || 0;
  }
  return byDate;
};

/**
 * Parse a numeric value that may be a string with commas (e.g. from iOS Shortcuts).
 *
 * Returns `undefined` for anything that isn't a usable non-negative number.
 * `undefined` specifically means "this metric was not reported", which the
 * upsert below treats as *leave the stored value alone* — the safe outcome
 * for junk input, and importantly NOT the same as 0 (which would overwrite a
 * real figure with zero).
 *
 * Previously this returned `NaN` for junk. That looked harmless because the
 * upsert's `create` branch runs `steps || 0`, coercing it — but the `update`
 * branch (every repeat sync of the same day) has no such coercion, so `NaN`
 * reached both the `HealthRecord` write and, via `calculatePointsDelta`, the
 * points ledger. Negatives passed straight through for the same reason.
 *
 * @param {any} val
 * @returns {number|undefined}
 */
export const parseHealthNumber = (val) => {
  if (val === undefined || val === null) return undefined;
  const parsed = Number(String(val).replace(/,/g, ''));
  // Rejects NaN and ±Infinity. A health metric can't be negative, and a
  // device reporting one is malfunctioning — drop it rather than write it.
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

/**
 * Last line of defence before a metric reaches the database.
 *
 * `parseHealthNumber` guards the webhook path, but `POST /health/sync` passes
 * its body through after express-validator, and a future caller could pass
 * anything. Rather than trust every call site, the write path itself drops
 * unusable values — an unusable metric becomes `undefined` ("not reported")
 * and the stored value is left untouched.
 */
const sanitizeMetrics = (metrics = {}) => {
  const out = {};
  for (const key of ['steps', 'calories', 'distanceKm', 'activeMinutes']) {
    const value = metrics[key];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) continue;
    out[key] = num;
  }
  return out;
};

export default { syncHealthRecord, aggregateByDate, parseHealthNumber };
