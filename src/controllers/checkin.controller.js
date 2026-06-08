import prisma from '../config/prisma.js';

/**
 * @desc    Check in to an activity by scanning its QR code
 * @route   POST /api/checkins/qr
 * @access  Private
 */
export const checkInByQR = async (req, res) => {
  try {
    const { qrCode, latitude, longitude } = req.body;
    const userId = req.user.id;

    // Find activity by QR code
    const activity = await prisma.activity.findUnique({
      where: { qrCode },
      include: {
        _count: {
          select: { checkIns: true },
        },
      },
    });

    if (!activity) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Invalid QR code. Activity not found.',
      });
    }

    // Validate activity status
    if (!['UPCOMING', 'ONGOING'].includes(activity.status)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: `Cannot check in. Activity is ${activity.status.toLowerCase()}.`,
      });
    }

    // Check if user already checked in
    const existingCheckIn = await prisma.checkIn.findUnique({
      where: {
        userId_activityId: {
          userId,
          activityId: activity.id,
        },
      },
    });

    if (existingCheckIn) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'You have already checked in to this activity.',
      });
    }

    // Check if activity is full
    if (activity.maxParticipants && activity._count.checkIns >= activity.maxParticipants) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Activity is full. No more check-ins allowed.',
      });
    }

    // Create check-in and award points in a transaction
    const [checkIn] = await prisma.$transaction([
      prisma.checkIn.create({
        data: {
          userId,
          activityId: activity.id,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          method: 'QR',
        },
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
            },
          },
          user: {
            select: { id: true, fullName: true, totalPoints: true },
          },
        },
      }),
      // Award points to the user
      prisma.user.update({
        where: { id: userId },
        data: {
          totalPoints: {
            increment: activity.points || 0,
          },
        },
      }),
    ]);

    return res.status(201).json({
      success: true,
      data: {
        checkIn,
        pointsAwarded: activity.points || 0,
      },
      message: `Successfully checked in to "${activity.title}". ${activity.points ? `+${activity.points} points!` : ''}`,
    });
  } catch (error) {
    console.error('checkInByQR error:', error);
    // Handle unique constraint violation (race condition)
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'You have already checked in to this activity.',
      });
    }
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to check in',
    });
  }
};

/**
 * @desc    Get current user's check-in history
 * @route   GET /api/checkins/history
 * @access  Private
 */
export const getCheckInHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [checkIns, total] = await Promise.all([
      prisma.checkIn.findMany({
        where: { userId },
        skip,
        take: limitNum,
        orderBy: { checkedInAt: 'desc' },
        include: {
          activity: {
            select: {
              id: true,
              title: true,
              description: true,
              location: true,
              startDate: true,
              endDate: true,
              status: true,
              points: true,
              imageUrl: true,
            },
          },
        },
      }),
      prisma.checkIn.count({ where: { userId } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        checkIns,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      message: 'Check-in history retrieved successfully',
    });
  } catch (error) {
    console.error('getCheckInHistory error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve check-in history',
    });
  }
};

/**
 * @desc    Get all check-ins for a specific activity (Admin only)
 * @route   GET /api/checkins/activity/:activityId
 * @access  Private/Admin
 */
export const getActivityCheckIns = async (req, res) => {
  try {
    const { activityId } = req.params;

    // Verify activity exists
    const activity = await prisma.activity.findUnique({
      where: { id: activityId },
      select: { id: true, title: true },
    });

    if (!activity) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Activity not found',
      });
    }

    const checkIns = await prisma.checkIn.findMany({
      where: { activityId },
      orderBy: { checkedInAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            department: true,
            avatarUrl: true,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        activity,
        checkIns,
        totalCheckIns: checkIns.length,
      },
      message: 'Activity check-ins retrieved successfully',
    });
  } catch (error) {
    console.error('getActivityCheckIns error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve activity check-ins',
    });
  }
};

/**
 * @desc    Cancel a check-in (only if activity hasn't started yet)
 * @route   DELETE /api/checkins/:id
 * @access  Private
 */
export const cancelCheckIn = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Find the check-in
    const checkIn = await prisma.checkIn.findUnique({
      where: { id },
      include: {
        activity: {
          select: {
            id: true,
            title: true,
            startDate: true,
            points: true,
            status: true,
          },
        },
      },
    });

    if (!checkIn) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Check-in not found',
      });
    }

    // Ensure the check-in belongs to the current user
    if (checkIn.userId !== userId) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'You can only cancel your own check-ins',
      });
    }

    // Only allow cancellation if the activity hasn't started yet
    const now = new Date();
    if (checkIn.activity.startDate <= now) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Cannot cancel check-in. The activity has already started.',
      });
    }

    // Delete the check-in and deduct points in a transaction
    await prisma.$transaction([
      prisma.checkIn.delete({
        where: { id },
      }),
      // Deduct the points that were awarded
      prisma.user.update({
        where: { id: userId },
        data: {
          totalPoints: {
            decrement: checkIn.activity.points || 0,
          },
        },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: null,
      message: `Check-in to "${checkIn.activity.title}" cancelled successfully. ${checkIn.activity.points ? `-${checkIn.activity.points} points.` : ''}`,
    });
  } catch (error) {
    console.error('cancelCheckIn error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to cancel check-in',
    });
  }
};
