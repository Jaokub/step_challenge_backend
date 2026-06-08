import prisma from '../config/prisma.js';

/**
 * @module HealthController
 * @description Controller for health data management operations
 */

/**
 * Sync health data from mobile app. Upserts based on [userId, recordDate, source].
 * @route POST /api/health/sync
 */
export const syncHealthData = async (req, res) => {
  try {
    const userId = req.user.id;
    const { recordDate, source, steps, calories, distanceKm, activeMinutes } = req.body;

    const parsedDate = new Date(recordDate);
    // Normalize to date only (strip time component)
    const normalizedDate = new Date(
      Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
    );

    if (isNaN(normalizedDate.getTime())) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid recordDate format',
      });
    }

    const validSources = ['GOOGLE_HEALTH', 'APPLE_HEALTH', 'MANUAL'];
    if (!validSources.includes(source)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: `Invalid source. Must be one of: ${validSources.join(', ')}`,
      });
    }

    const healthRecord = await prisma.healthRecord.upsert({
      where: {
        userId_recordDate_source: {
          userId,
          recordDate: normalizedDate,
          source,
        },
      },
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

    return res.status(200).json({
      success: true,
      data: healthRecord,
      message: 'Health data synced successfully',
    });
  } catch (error) {
    console.error('Error syncing health data:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to sync health data',
    });
  }
};

/**
 * Get current user's health records with optional date range filter, sorted by date desc
 * @route GET /api/health/history
 */
export const getMyHealthHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate, limit } = req.query;

    const where = { userId };

    // Apply date range filter if provided
    if (startDate || endDate) {
      where.recordDate = {};
      if (startDate) {
        const parsedStart = new Date(startDate);
        if (!isNaN(parsedStart.getTime())) {
          where.recordDate.gte = parsedStart;
        }
      }
      if (endDate) {
        const parsedEnd = new Date(endDate);
        if (!isNaN(parsedEnd.getTime())) {
          // Set to end of day
          parsedEnd.setUTCHours(23, 59, 59, 999);
          where.recordDate.lte = parsedEnd;
        }
      }
    }

    const take = limit ? Math.min(parseInt(limit, 10), 365) : 30;

    const records = await prisma.healthRecord.findMany({
      where,
      orderBy: { recordDate: 'desc' },
      take: isNaN(take) ? 30 : take,
    });

    return res.json({
      success: true,
      data: records,
      message: 'Health history retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching health history:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch health history',
    });
  }
};

/**
 * Get current user's health summary — today's data, weekly average, monthly total, best day
 * @route GET /api/health/summary
 */
export const getHealthSummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    // Today (UTC)
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    // Start of current week (Monday)
    const dayOfWeek = now.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));

    // Start of current month
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Fetch all records in parallel
    const [todayRecords, weekRecords, monthRecords, bestDayRecord] = await Promise.all([
      // Today's data
      prisma.healthRecord.findMany({
        where: {
          userId,
          recordDate: { gte: todayStart, lte: todayEnd },
        },
      }),
      // This week's records (for weekly average)
      prisma.healthRecord.findMany({
        where: {
          userId,
          recordDate: { gte: weekStart, lte: todayEnd },
        },
      }),
      // This month's records (for monthly total)
      prisma.healthRecord.findMany({
        where: {
          userId,
          recordDate: { gte: monthStart, lte: todayEnd },
        },
      }),
      // Best day (most steps) — all time
      prisma.healthRecord.findFirst({
        where: { userId },
        orderBy: { steps: 'desc' },
      }),
    ]);

    // Aggregate today's data (could have multiple sources)
    const today = {
      steps: todayRecords.reduce((sum, r) => sum + (r.steps || 0), 0),
      calories: todayRecords.reduce((sum, r) => sum + (r.calories || 0), 0),
      distanceKm: todayRecords.reduce((sum, r) => sum + (r.distanceKm || 0), 0),
      activeMinutes: todayRecords.reduce((sum, r) => sum + (r.activeMinutes || 0), 0),
    };

    // Aggregate by date for weekly average
    const weekByDate = aggregateByDate(weekRecords);
    const weekDaysWithData = Object.keys(weekByDate).length || 1;
    const weekTotals = Object.values(weekByDate).reduce(
      (acc, day) => ({
        steps: acc.steps + day.steps,
        calories: acc.calories + day.calories,
        distanceKm: acc.distanceKm + day.distanceKm,
        activeMinutes: acc.activeMinutes + day.activeMinutes,
      }),
      { steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 }
    );

    const weeklyAverage = {
      steps: Math.round(weekTotals.steps / weekDaysWithData),
      calories: Math.round(weekTotals.calories / weekDaysWithData),
      distanceKm: parseFloat((weekTotals.distanceKm / weekDaysWithData).toFixed(2)),
      activeMinutes: Math.round(weekTotals.activeMinutes / weekDaysWithData),
      daysWithData: weekDaysWithData,
    };

    // Monthly total
    const monthByDate = aggregateByDate(monthRecords);
    const monthlyTotal = Object.values(monthByDate).reduce(
      (acc, day) => ({
        steps: acc.steps + day.steps,
        calories: acc.calories + day.calories,
        distanceKm: acc.distanceKm + day.distanceKm,
        activeMinutes: acc.activeMinutes + day.activeMinutes,
      }),
      { steps: 0, calories: 0, distanceKm: 0, activeMinutes: 0 }
    );
    monthlyTotal.distanceKm = parseFloat(monthlyTotal.distanceKm.toFixed(2));
    monthlyTotal.daysWithData = Object.keys(monthByDate).length;

    // Best day
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
      data: {
        today,
        weeklyAverage,
        monthlyTotal,
        bestDay,
      },
      message: 'Health summary retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching health summary:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch health summary',
    });
  }
};

/**
 * Get just today's health data
 * @route GET /api/health/today
 */
export const getTodayHealth = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    const records = await prisma.healthRecord.findMany({
      where: {
        userId,
        recordDate: { gte: todayStart, lte: todayEnd },
      },
    });

    // Aggregate across all sources for today
    const aggregated = {
      steps: records.reduce((sum, r) => sum + (r.steps || 0), 0),
      calories: records.reduce((sum, r) => sum + (r.calories || 0), 0),
      distanceKm: records.reduce((sum, r) => sum + (r.distanceKm || 0), 0),
      activeMinutes: records.reduce((sum, r) => sum + (r.activeMinutes || 0), 0),
      sources: records.map((r) => r.source),
      date: todayStart.toISOString().split('T')[0],
    };

    return res.json({
      success: true,
      data: {
        aggregated,
        records,
      },
      message: "Today's health data retrieved successfully",
    });
  } catch (error) {
    console.error("Error fetching today's health:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Failed to fetch today's health data",
    });
  }
};

/**
 * Sync health data via webhook (iOS Shortcuts)
 * @route POST /api/health/webhook
 */
export const syncFromWebhook = async (req, res) => {
  try {
    const { syncToken, steps, distanceKm, calories, activeMinutes, source } = req.body;

    if (!syncToken) {
      return res.status(401).json({ success: false, message: 'Missing syncToken' });
    }

    const user = await prisma.user.findUnique({
      where: { syncToken },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid syncToken' });
    }

    const now = new Date();
    const normalizedDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const healthSource = source || 'APPLE_HEALTH';

    const parseNumber = (val) => val ? Number(String(val).replace(/,/g, '')) : undefined;

    const healthRecord = await prisma.healthRecord.upsert({
      where: {
        userId_recordDate_source: {
          userId: user.id,
          recordDate: normalizedDate,
          source: healthSource,
        },
      },
      update: {
        steps: steps !== undefined ? parseNumber(steps) : undefined,
        distanceKm: distanceKm !== undefined ? parseNumber(distanceKm) : undefined,
        calories: calories !== undefined ? parseNumber(calories) : undefined,
        activeMinutes: activeMinutes !== undefined ? parseNumber(activeMinutes) : undefined,
        createdAt: new Date(),
      },
      create: {
        userId: user.id,
        recordDate: normalizedDate,
        source: healthSource,
        steps: parseNumber(steps) || 0,
        distanceKm: parseNumber(distanceKm) || 0,
        calories: parseNumber(calories) || 0,
        activeMinutes: parseNumber(activeMinutes) || 0,
      },
    });

    return res.status(200).json({
      success: true,
      data: healthRecord,
      message: 'Health data synced via webhook successfully',
    });
  } catch (error) {
    console.error('Error in webhook sync:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync health data from webhook',
    });
  }
};

/**
 * Helper: aggregate health records by date (combining multiple sources per day)
 * @param {Array} records - Array of health records
 * @returns {Object} Records aggregated by date string
 */
function aggregateByDate(records) {
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
}
