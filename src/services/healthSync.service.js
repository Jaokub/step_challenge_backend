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
  const { steps, calories, distanceKm, activeMinutes } = metrics;

  // Streak lookup stays outside the transaction (read-only, non-critical).
  const currentStreak = await calculateCheckInStreak(userId);

  // Read-compute-write happens inside ONE transaction so two concurrent
  // syncs can't both read the same "old" record and double-award the delta.
  return prisma.$transaction(async (tx) => {
    const existingRecord = await tx.healthRecord.findUnique({
      where: { userId_recordDate_source: { userId, recordDate: normalizedDate, source } },
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
      where: { userId_recordDate_source: { userId, recordDate: normalizedDate, source } },
      update: {
        steps: steps !== undefined ? steps : undefined,
        calories: calories !== undefined ? calories : undefined,
        distanceKm: distanceKm !== undefined ? distanceKm : undefined,
        activeMinutes: activeMinutes !== undefined ? activeMinutes : undefined,
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
 * Aggregate health records by date, combining multiple sources per day.
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
 * @param {any} val
 * @returns {number|undefined}
 */
export const parseHealthNumber = (val) =>
  val !== undefined && val !== null ? Number(String(val).replace(/,/g, '')) : undefined;

export default { syncHealthRecord, aggregateByDate, parseHealthNumber };
