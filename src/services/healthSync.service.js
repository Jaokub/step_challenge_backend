/**
 * @module HealthSyncService
 * @description Domain service for syncing health records and awarding points.
 * Encapsulates the upsert + points transaction logic that was duplicated across
 * the syncHealthData and syncFromWebhook controller handlers.
 */
import prisma from '../config/prisma.js';
import pointsService from './points.service.js';
import { calculateCheckInStreak } from './streak.service.js';

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
 * @returns {Promise<Object>} The upserted health record.
 */
export const syncHealthRecord = async (userId, normalizedDate, source, metrics) => {
  const { steps, calories, distanceKm, activeMinutes } = metrics;

  const existingRecord = await prisma.healthRecord.findUnique({
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

  const currentStreak = await calculateCheckInStreak(userId);
  const deltaPoints = pointsService.calculatePointsDelta(oldMetrics, newMetrics, currentStreak);

  const upsertData = {
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
  };

  if (deltaPoints !== 0) {
    const [upsertedRecord] = await prisma.$transaction(async (tx) => {
      const upserted = await tx.healthRecord.upsert(upsertData);

      if (deltaPoints > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { totalPoints: { increment: deltaPoints } },
        });
      } else {
        // Clamp: never let totalPoints drop below 0
        const user = await tx.user.findUnique({ where: { id: userId }, select: { totalPoints: true } });
        const safeDecrement = Math.min(Math.abs(deltaPoints), user?.totalPoints ?? 0);
        if (safeDecrement > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { totalPoints: { decrement: safeDecrement } },
          });
        }
      }

      return upserted;
    });
    return upsertedRecord;
  }

  return prisma.healthRecord.upsert(upsertData);
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
