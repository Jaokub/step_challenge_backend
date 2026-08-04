import prisma from '../config/prisma.js';
import { calculateCheckInStreak } from '../services/streak.service.js';
import { thaiDayTag, thaiDayTagEnd, thaiMonthStartInstant, thaiParts } from '../utils/thaiTime.js';
import { activityStatusWhere, upcomingOrOngoingWhere } from '../utils/activityStatus.js';

/**
 * @desc    Get personal dashboard data for the current user
 * @route   GET /api/dashboard/personal
 * @access  Private
 */
export const getPersonalDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const todayStart = thaiDayTag();
    const todayEnd = thaiDayTagEnd();

    const [
      user,
      totalActivitiesJoined,
      recentCheckIns,
      upcomingActivities,
      todayHealth,
      streak,
    ] = await Promise.all([
      // Get user with total points
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          department: true,
          totalPoints: true,
          avatarUrl: true,
        },
      }),

      // Total activities joined
      prisma.checkIn.count({
        where: { userId },
      }),

      // Recent check-ins (last 5)
      prisma.checkIn.findMany({
        where: { userId },
        orderBy: { checkedInAt: 'desc' },
        take: 5,
        include: {
          activity: {
            select: {
              id: true,
              title: true,
              location: true,
              startDate: true,
              endDate: true,
              points: true,
              status: true,
              imageUrl: true,
            },
          },
        },
      }),

      // Next 5 activities that haven't finished and that this user hasn't
      // checked into yet.
      //
      // Both halves of that sentence were broken until 2026-08-03
      // (TEST_FINDINGS F3 + F4):
      //   - the filter was `status IN ('UPCOMING','ONGOING') AND startDate >=
      //     now`, so an activity happening RIGHT NOW could never appear — it
      //     has already started, so `startDate >= now` excluded it and the
      //     'ONGOING' half of the status clause was dead. It was also the last
      //     reader still trusting the stored `status` column, which
      //     activityStatus.js exists to stop anyone doing (the column is
      //     assign-once and never transitions).
      //   - "that user hasn't checked into yet" was only ever a comment; the
      //     query had no `userId` in it at all, so an activity you had already
      //     attended kept occupying one of your five slots.
      prisma.activity.findMany({
        where: {
          ...upcomingOrOngoingWhere(now),
          checkIns: { none: { userId } },
        },
        orderBy: { startDate: 'asc' },
        take: 5,
        include: {
          _count: { select: { checkIns: true } },
          createdBy: {
            select: { id: true, fullName: true },
          },
        },
      }),

      // Today's health data
      prisma.healthRecord.findMany({
        where: {
          userId,
          recordDate: {
            gte: todayStart,
            lte: todayEnd,
          },
        },
      }),

      // Calculate streak: consecutive days with check-ins
      calculateCheckInStreak(userId),
    ]);

    const upcomingWithCount = upcomingActivities.map((a) => ({
      ...a,
      participantCount: a._count.checkIns,
      _count: undefined,
    }));

    // Aggregate today's health data across sources
    const todayHealthSummary = todayHealth.length > 0
      ? {
          steps: todayHealth.reduce((sum, r) => sum + (r.steps || 0), 0),
          calories: todayHealth.reduce((sum, r) => sum + (r.calories || 0), 0),
          distanceKm: todayHealth.reduce((sum, r) => sum + (r.distanceKm || 0), 0),
          activeMinutes: todayHealth.reduce((sum, r) => sum + (r.activeMinutes || 0), 0),
          sources: todayHealth.map((r) => r.source),
        }
      : null;

    return res.status(200).json({
      success: true,
      data: {
        user,
        totalActivitiesJoined,
        totalPoints: user?.totalPoints || 0,
        currentStreak: streak,
        recentCheckIns,
        upcomingActivities: upcomingWithCount,
        todayHealth: todayHealthSummary,
      },
      message: 'Personal dashboard retrieved successfully',
    });
  } catch (error) {
    console.error('getPersonalDashboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve personal dashboard',
    });
  }
};

/**
 * @desc    Get admin dashboard data
 * @route   GET /api/dashboard/admin
 * @access  Private/Admin
 */
export const getAdminDashboard = async (req, res) => {
  try {
    const monthStart = thaiMonthStartInstant();

    const [
      totalUsers,
      totalActivities,
      checkInsThisMonth,
      mostActiveUsers,
      mostPopularActivities,
      totalCheckInsAll,
      totalActivitiesWithCheckIns,
      recentCheckIns,
    ] = await Promise.all([
      // Total users
      prisma.user.count(),

      // Total activities (excluding cancelled)
      prisma.activity.count({
        where: { status: { not: 'CANCELLED' } },
      }),

      // Check-ins this month
      prisma.checkIn.count({
        where: {
          checkedInAt: { gte: monthStart },
        },
      }),

      // Most active users (top 5 by check-in count).
      //
      // Ordered by the same figure the screen shows. Until 2026-08-03 this
      // said `orderBy: { totalPoints: 'desc' }` while surfacing
      // `checkInCount`, so the list could legitimately read 9, 2, 30 — sorted
      // by one number, labelled with another (TEST_FINDINGS F5). Worse,
      // `totalPoints` is the dormant cache: points accrue mostly from
      // HEALTH_SYNC, so it ranked whoever synced their phone most often, not
      // whoever turned up to activities.
      //
      // `totalPoints` stays in the select rather than being stripped — the
      // ledger is deliberately dormant, not dismantled (CLAUDE.md), and the
      // mobile `User` type still declares the field. Just don't rank by it.
      prisma.user.findMany({
        orderBy: { checkIns: { _count: 'desc' } },
        take: 5,
        select: {
          id: true,
          fullName: true,
          department: true,
          avatarUrl: true,
          totalPoints: true,
          _count: {
            select: { checkIns: true },
          },
        },
      }),

      // Most popular activities (top 5 by check-in count)
      prisma.activity.findMany({
        where: { status: { not: 'CANCELLED' } },
        orderBy: {
          checkIns: { _count: 'desc' },
        },
        take: 5,
        select: {
          id: true,
          title: true,
          location: true,
          startDate: true,
          status: true,
          points: true,
          _count: {
            select: { checkIns: true },
          },
        },
      }),

      // Total check-ins (all time) for participation rate
      prisma.checkIn.count(),

      // Total activities that have at least one check-in
      prisma.activity.count({
        where: {
          status: { not: 'CANCELLED' },
          checkIns: { some: {} },
        },
      }),

      // Recent check-ins (last 10)
      prisma.checkIn.findMany({
        orderBy: { checkedInAt: 'desc' },
        take: 10,
        include: {
          user: {
            select: { id: true, fullName: true, department: true, avatarUrl: true },
          },
          activity: {
            select: { id: true, title: true, location: true },
          },
        },
      }),
    ]);

    const mostActiveUsersFormatted = mostActiveUsers.map((u) => ({
      ...u,
      checkInCount: u._count.checkIns,
      _count: undefined,
    }));

    const mostPopularActivitiesFormatted = mostPopularActivities.map((a) => ({
      ...a,
      participantCount: a._count.checkIns,
      _count: undefined,
    }));

    // Participation rate: percentage of activities that have at least one check-in
    const participationRate = totalActivities > 0
      ? Math.round((totalActivitiesWithCheckIns / totalActivities) * 100 * 100) / 100
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalActivities,
        checkInsThisMonth,
        totalCheckIns: totalCheckInsAll,
        participationRate,
        mostActiveUsers: mostActiveUsersFormatted,
        mostPopularActivities: mostPopularActivitiesFormatted,
        recentCheckIns,
      },
      message: 'Admin dashboard retrieved successfully',
    });
  } catch (error) {
    console.error('getAdminDashboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve admin dashboard',
    });
  }
};

/**
 * @desc    Get general statistics
 * @route   GET /api/dashboard/stats
 * @access  Private
 */
export const getStats = async (req, res) => {
  try {
    const now = new Date();

    // Activities by status count — derived from dates, not the stored
    // column (utils/activityStatus.js: the column is set once at creation
    // and never transitions), so this KPI can't drift from what the
    // activities list/pills show for the same activity.
    const [upcomingCount, ongoingCount, completedCount, cancelledCount] = await Promise.all([
      prisma.activity.count({ where: activityStatusWhere('UPCOMING', now) }),
      prisma.activity.count({ where: activityStatusWhere('ONGOING', now) }),
      prisma.activity.count({ where: activityStatusWhere('COMPLETED', now) }),
      prisma.activity.count({ where: activityStatusWhere('CANCELLED', now) }),
    ]);

    const statusCounts = {
      UPCOMING: upcomingCount,
      ONGOING: ongoingCount,
      COMPLETED: completedCount,
      CANCELLED: cancelledCount,
    };

    // Build Thai-month boundaries (as real UTC instants) for the last 6 months.
    // Labels are derived from a UTC-midnight tag of the Thai month so they stay
    // correct regardless of the host machine's timezone.
    const { year: thaiYear, month: thaiMonth } = thaiParts(now);
    const monthRanges = Array.from({ length: 6 }, (_, i) => {
      const monthsAgo = 5 - i;
      const monthStart = thaiMonthStartInstant(now, monthsAgo);
      const monthEnd = thaiMonthStartInstant(now, monthsAgo - 1);
      const labelTag = new Date(Date.UTC(thaiYear, thaiMonth - monthsAgo, 1));
      return { monthStart, monthEnd, labelTag };
    });

    // Run all 12 count queries in parallel instead of sequentially
    const [checkInCounts, userCounts] = await Promise.all([
      Promise.all(
        monthRanges.map(({ monthStart, monthEnd }) =>
          prisma.checkIn.count({ where: { checkedInAt: { gte: monthStart, lt: monthEnd } } })
        )
      ),
      Promise.all(
        monthRanges.map(({ monthStart, monthEnd }) =>
          prisma.user.count({ where: { createdAt: { gte: monthStart, lt: monthEnd } } })
        )
      ),
    ]);

    const checkInsByMonth = monthRanges.map(({ labelTag }, i) => ({
      year: labelTag.getUTCFullYear(),
      month: labelTag.getUTCMonth() + 1,
      monthName: labelTag.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      count: checkInCounts[i],
    }));

    const newUsersByMonth = monthRanges.map(({ labelTag }, i) => ({
      year: labelTag.getUTCFullYear(),
      month: labelTag.getUTCMonth() + 1,
      monthName: labelTag.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      count: userCounts[i],
    }));

    return res.status(200).json({
      success: true,
      data: {
        activitiesByStatus: statusCounts,
        checkInsByMonth,
        newUsersByMonth,
      },
      message: 'Statistics retrieved successfully',
    });
  } catch (error) {
    console.error('getStats error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve statistics',
    });
  }
};

