import prisma from '../config/prisma.js';

/**
 * @desc    Get personal dashboard data for the current user
 * @route   GET /api/dashboard/personal
 * @access  Private
 */
export const getPersonalDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

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

      // Upcoming activities (next 5 that user hasn't checked into yet)
      prisma.activity.findMany({
        where: {
          status: { in: ['UPCOMING', 'ONGOING'] },
          startDate: { gte: now },
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
      calculateStreak(userId),
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
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

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

      // Most active users (top 5 by check-in count)
      prisma.user.findMany({
        orderBy: { totalPoints: 'desc' },
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

    // Activities by status count
    const activitiesByStatus = await prisma.activity.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const statusCounts = {
      UPCOMING: 0,
      ONGOING: 0,
      COMPLETED: 0,
      CANCELLED: 0,
    };
    activitiesByStatus.forEach((item) => {
      statusCounts[item.status] = item._count.id;
    });

    // Check-ins by month (last 6 months)
    const checkInsByMonth = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      const count = await prisma.checkIn.count({
        where: {
          checkedInAt: {
            gte: monthStart,
            lt: monthEnd,
          },
        },
      });

      checkInsByMonth.push({
        year: monthStart.getFullYear(),
        month: monthStart.getMonth() + 1,
        monthName: monthStart.toLocaleString('en-US', { month: 'short' }),
        count,
      });
    }

    // New users by month (last 6 months)
    const newUsersByMonth = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      const count = await prisma.user.count({
        where: {
          createdAt: {
            gte: monthStart,
            lt: monthEnd,
          },
        },
      });

      newUsersByMonth.push({
        year: monthStart.getFullYear(),
        month: monthStart.getMonth() + 1,
        monthName: monthStart.toLocaleString('en-US', { month: 'short' }),
        count,
      });
    }

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

/**
 * Calculate the current check-in streak for a user.
 * A streak is the number of consecutive days (ending today or yesterday)
 * that the user has at least one check-in.
 *
 * @param {string} userId - The user's ID
 * @returns {Promise<number>} The current streak count
 */
async function calculateStreak(userId) {
  try {
    // Get distinct check-in dates, ordered descending
    const checkIns = await prisma.checkIn.findMany({
      where: { userId },
      orderBy: { checkedInAt: 'desc' },
      select: { checkedInAt: true },
    });

    if (checkIns.length === 0) return 0;

    // Extract unique dates (date strings only, no time)
    const uniqueDates = [
      ...new Set(
        checkIns.map((ci) => {
          const d = new Date(ci.checkedInAt);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })
      ),
    ].sort((a, b) => b.localeCompare(a)); // descending

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    // Streak must start from today or yesterday
    if (uniqueDates[0] !== todayStr && uniqueDates[0] !== yesterdayStr) {
      return 0;
    }

    let streak = 1;
    for (let i = 1; i < uniqueDates.length; i++) {
      const prevDate = new Date(uniqueDates[i - 1]);
      const currDate = new Date(uniqueDates[i]);
      const diffMs = prevDate.getTime() - currDate.getTime();
      const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

      if (diffDays === 1) {
        streak++;
      } else {
        break;
      }
    }

    return streak;
  } catch (error) {
    console.error('calculateStreak error:', error);
    return 0;
  }
}
