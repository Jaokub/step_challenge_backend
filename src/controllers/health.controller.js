import prisma from '../config/prisma.js';
import { syncHealthRecord, aggregateByDate } from '../services/healthSync.service.js';
import { parseHealthNumber } from '../services/healthSync.service.js';
import {
  thaiDayTag,
  thaiDayTagEnd,
  thaiWeekStartTag,
  thaiMonthStartTag,
  addDays,
  tagToDateString,
  tagWeekday,
} from '../utils/thaiTime.js';

const VALID_SOURCES = ['GOOGLE_HEALTH', 'APPLE_HEALTH', 'MANUAL'];

/**
 * Normalise a client-supplied date string to the UTC-midnight tag of its Thai
 * calendar day (the `@db.Date` storage convention for recordDate).
 * @param {string} dateStr
 * @returns {{ date: Date|null, error: string|null }}
 */
const normaliseDate = (dateStr) => {
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return { date: null, error: 'Invalid recordDate format' };
  return { date: thaiDayTag(parsed), error: null };
};

/**
 * Sync health data from the mobile app. Upserts on [userId, recordDate, source].
 * @route POST /api/health/sync
 */
export const syncHealthData = async (req, res) => {
  try {
    const userId = req.user.id;
    const { recordDate, source, steps, calories, distanceKm, activeMinutes } = req.body;

    const { date: normalizedDate, error: dateError } = normaliseDate(recordDate);
    if (dateError) {
      return res.status(400).json({ success: false, data: null, message: dateError });
    }

    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`,
      });
    }

    const healthRecord = await syncHealthRecord(userId, normalizedDate, source, {
      steps, calories, distanceKm, activeMinutes,
    });

    return res.status(200).json({
      success: true,
      data: healthRecord,
      message: 'Health data synced successfully',
    });
  } catch (error) {
    console.error('syncHealthData error:', error);
    return res.status(500).json({ success: false, data: null, message: 'Failed to sync health data' });
  }
};

/**
 * Sync health data via webhook (iOS Shortcuts). Authenticated by syncToken.
 * @route POST /api/health/webhook
 */
export const syncFromWebhook = async (req, res) => {
  try {
    const { syncToken, steps, distanceKm, calories, activeMinutes, source } = req.body;

    if (!syncToken) {
      return res.status(401).json({ success: false, message: 'Missing syncToken' });
    }

    const user = await prisma.user.findUnique({ where: { syncToken } });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid syncToken' });
    }

    const normalizedDate = thaiDayTag();
    const healthSource = source || 'APPLE_HEALTH';

    const healthRecord = await syncHealthRecord(user.id, normalizedDate, healthSource, {
      steps: parseHealthNumber(steps),
      calories: parseHealthNumber(calories),
      distanceKm: parseHealthNumber(distanceKm),
      activeMinutes: parseHealthNumber(activeMinutes),
    });

    return res.status(200).json({
      success: true,
      data: healthRecord,
      message: 'Health data synced via webhook successfully',
    });
  } catch (error) {
    console.error('syncFromWebhook error:', error);
    return res.status(500).json({ success: false, message: 'Failed to sync health data from webhook' });
  }
};

/**
 * Get current user's health records with optional date range filter.
 * @route GET /api/health/history
 */
export const getMyHealthHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate, limit } = req.query;

    const where = { userId };

    if (startDate || endDate) {
      where.recordDate = {};
      if (startDate) {
        const parsed = new Date(startDate);
        if (!isNaN(parsed.getTime())) where.recordDate.gte = thaiDayTag(parsed);
      }
      if (endDate) {
        const parsed = new Date(endDate);
        if (!isNaN(parsed.getTime())) where.recordDate.lte = thaiDayTagEnd(parsed);
      }
    }

    const take = limit ? Math.min(parseInt(limit, 10), 365) : 30;

    const records = await prisma.healthRecord.findMany({
      where,
      orderBy: { recordDate: 'desc' },
      take: isNaN(take) ? 30 : take,
    });

    return res.json({ success: true, data: records, message: 'Health history retrieved successfully' });
  } catch (error) {
    console.error('getMyHealthHistory error:', error);
    return res.status(500).json({ success: false, data: null, message: 'Failed to fetch health history' });
  }
};

/**
 * Get health summary: today, weekly average, monthly total, best day.
 * @route GET /api/health/summary
 */
export const getHealthSummary = async (req, res) => {
  try {
    const userId = req.user.id;

    const todayStart = thaiDayTag();
    const todayEnd = thaiDayTagEnd();
    const weekStart = thaiWeekStartTag();
    const monthStart = thaiMonthStartTag();

    const [todayRecords, weekRecords, monthRecords, bestDayRecord] = await Promise.all([
      prisma.healthRecord.findMany({ where: { userId, recordDate: { gte: todayStart, lte: todayEnd } } }),
      prisma.healthRecord.findMany({ where: { userId, recordDate: { gte: weekStart, lte: todayEnd } } }),
      prisma.healthRecord.findMany({ where: { userId, recordDate: { gte: monthStart, lte: todayEnd } } }),
      prisma.healthRecord.findFirst({ where: { userId }, orderBy: { steps: 'desc' } }),
    ]);

    const today = sumRecords(todayRecords);

    const weekByDate = aggregateByDate(weekRecords);
    const weekDaysWithData = Object.keys(weekByDate).length || 1;
    const weekTotals = sumAggregated(weekByDate);
    const weeklyAverage = {
      steps: Math.round(weekTotals.steps / weekDaysWithData),
      calories: Math.round(weekTotals.calories / weekDaysWithData),
      distanceKm: parseFloat((weekTotals.distanceKm / weekDaysWithData).toFixed(2)),
      activeMinutes: Math.round(weekTotals.activeMinutes / weekDaysWithData),
      daysWithData: weekDaysWithData,
    };

    const monthByDate = aggregateByDate(monthRecords);
    const monthlyTotal = sumAggregated(monthByDate);
    monthlyTotal.distanceKm = parseFloat(monthlyTotal.distanceKm.toFixed(2));
    monthlyTotal.daysWithData = Object.keys(monthByDate).length;

    const bestDay = bestDayRecord
      ? {
          date: bestDayRecord.recordDate,
          steps: bestDayRecord.steps,
          calories: bestDayRecord.calories,
          distanceKm: bestDayRecord.distanceKm,
          activeMinutes: bestDayRecord.activeMinutes,
          source: bestDayRecord.source,
        }
      : null;

    return res.json({
      success: true,
      data: { today, weeklyAverage, monthlyTotal, bestDay },
      message: 'Health summary retrieved successfully',
    });
  } catch (error) {
    console.error('getHealthSummary error:', error);
    return res.status(500).json({ success: false, data: null, message: 'Failed to fetch health summary' });
  }
};

/**
 * Get today's aggregated health data.
 * @route GET /api/health/today
 */
export const getTodayHealth = async (req, res) => {
  try {
    const userId = req.user.id;

    const todayStart = thaiDayTag();
    const todayEnd = thaiDayTagEnd();

    const records = await prisma.healthRecord.findMany({
      where: { userId, recordDate: { gte: todayStart, lte: todayEnd } },
    });

    const aggregated = {
      ...sumRecords(records),
      sources: records.map((r) => r.source),
      date: tagToDateString(todayStart),
    };

    return res.json({
      success: true,
      data: { aggregated, records },
      message: "Today's health data retrieved successfully",
    });
  } catch (error) {
    console.error('getTodayHealth error:', error);
    return res.status(500).json({ success: false, data: null, message: "Failed to fetch today's health data" });
  }
};

/**
 * Get weekly chart data (last 7 days of steps).
 * @route GET /api/health/weekly-chart
 */
export const getWeeklyChart = async (req, res) => {
  try {
    const userId = req.user.id;

    const todayTag = thaiDayTag();
    const todayEnd = thaiDayTagEnd();
    const sixDaysAgoStart = addDays(todayTag, -6);

    const records = await prisma.healthRecord.findMany({
      where: {
        userId,
        recordDate: {
          gte: sixDaysAgoStart,
          lte: todayEnd,
        },
      },
    });

    const aggregated = aggregateByDate(records);

    const chartData = [];
    const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

    for (let i = 6; i >= 0; i--) {
      const d = addDays(todayTag, -i);
      const dateStr = tagToDateString(d);
      const dayName = dayNames[tagWeekday(d)];
      const dayData = aggregated[dateStr] || { steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 };
      
      chartData.push({
        date: dateStr,
        dayName,
        steps: dayData.steps,
      });
    }

    return res.json({
      success: true,
      data: chartData,
      message: 'Weekly chart data retrieved successfully',
    });
  } catch (error) {
    console.error('getWeeklyChart error:', error);
    return res.status(500).json({ success: false, data: null, message: 'Failed to fetch weekly chart data' });
  }
};

// ─── Private Helpers ──────────────────────────────────────────────────────────

/** Sum raw health records into a single metrics object. */
const sumRecords = (records) => ({
  steps: records.reduce((sum, r) => sum + (r.steps || 0), 0),
  calories: records.reduce((sum, r) => sum + (r.calories || 0), 0),
  distanceKm: records.reduce((sum, r) => sum + (r.distanceKm || 0), 0),
  activeMinutes: records.reduce((sum, r) => sum + (r.activeMinutes || 0), 0),
});

/** Sum values from an aggregateByDate result. */
const sumAggregated = (byDate) =>
  Object.values(byDate).reduce(
    (acc, day) => ({
      steps: acc.steps + day.steps,
      calories: acc.calories + day.calories,
      distanceKm: acc.distanceKm + day.distanceKm,
      activeMinutes: acc.activeMinutes + day.activeMinutes,
    }),
    { steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 }
  );
