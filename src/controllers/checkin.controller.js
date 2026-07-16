import prisma from '../config/prisma.js';
import { applyPoints } from '../services/pointsLedger.service.js';
import { thaiDayTag } from '../utils/thaiTime.js';
import { createCheckIn, CheckInError } from '../services/checkin.service.js';

const CHECKIN_ERROR_STATUS = { INVALID_STATUS: 400, DUPLICATE: 409, FULL: 400, CONFLICT: 409 };

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
    const activity = await prisma.activity.findUnique({ where: { qrCode } });

    if (!activity) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Invalid QR code. Activity not found.',
      });
    }

    let checkIn;
    let pointsAwarded;
    try {
      ({ checkIn, pointsAwarded } = await createCheckIn({
        activity,
        userId,
        method: 'QR',
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      }));
    } catch (err) {
      if (err instanceof CheckInError) {
        const message = err.code === 'DUPLICATE' ? 'You have already checked in to this activity.' : err.message;
        return res.status(CHECKIN_ERROR_STATUS[err.code] || 400).json({ success: false, data: null, message });
      }
      throw err;
    }

    // For a step-gated activity nothing is paid at check-in — report the
    // real awarded amount (usually 0) so the client never shows a false
    // "+points". Proper "walk to earn" copy is PR 2.
    return res.status(201).json({
      success: true,
      data: {
        checkIn,
        pointsAwarded,
      },
      message: `Successfully checked in to "${activity.title}".${pointsAwarded ? ` +${pointsAwarded} points!` : ''}`,
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
 * @desc    Manually check a user in to an activity (front-desk / walk-in flow).
 *          Awards points through the same `createCheckIn` path as a QR
 *          check-in — pointsLedger stays the single source of truth.
 * @route   POST /api/checkins/admin-checkin
 * @access  Private/Admin
 */
export const adminCheckIn = async (req, res) => {
  try {
    const { activityId, userId } = req.body;

    const [activity, targetUser] = await Promise.all([
      prisma.activity.findUnique({ where: { id: activityId } }),
      prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ]);

    if (!activity) {
      return res.status(404).json({ success: false, data: null, message: 'Activity not found.' });
    }
    if (!targetUser) {
      return res.status(404).json({ success: false, data: null, message: 'User not found.' });
    }

    let checkIn;
    let pointsAwarded;
    try {
      ({ checkIn, pointsAwarded } = await createCheckIn({ activity, userId, method: 'MANUAL' }));
    } catch (err) {
      if (err instanceof CheckInError) {
        const message =
          err.code === 'DUPLICATE' ? 'This person has already checked in to this activity.' : err.message;
        return res.status(CHECKIN_ERROR_STATUS[err.code] || 400).json({ success: false, data: null, message });
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      data: {
        checkIn,
        pointsAwarded,
      },
      message: `Checked in successfully.${pointsAwarded ? ` +${pointsAwarded} points.` : ''}`,
    });
  } catch (error) {
    console.error('adminCheckIn error:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'This person has already checked in to this activity.',
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
              // PR 2 (ADR-001 Phase 7): useActiveEventPolling filters this
              // list for ONGOING, step-gated, not-yet-paid check-ins to
              // decide whether to run the foreground sync poll.
              expectedSteps: true,
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
    const { page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

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

    const [checkIns, total] = await Promise.all([
      prisma.checkIn.findMany({
        where: { activityId },
        skip,
        take: limitNum,
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
      }),
      prisma.checkIn.count({ where: { activityId } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        activity,
        checkIns,
        totalCheckIns: total,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
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
 * @desc    Cancel a check-in. Self-service is only allowed before the
 *          activity starts (prevents gaming the system after the fact).
 *          An admin may cancel *any* check-in at any time — this is the
 *          "เลิกเช็คอิน" undo action for a manual/QR check-in mistake made
 *          mid-activity, so the time restriction doesn't apply to it.
 * @route   DELETE /api/checkins/:id
 * @access  Private
 */
export const cancelCheckIn = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'ADMIN';

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

    const isOwnCheckIn = checkIn.userId === userId;

    // Must be either the owner or an admin
    if (!isOwnCheckIn && !isAdmin) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'You can only cancel your own check-ins',
      });
    }

    // Self-service cancellation only allowed before the activity starts.
    // Admin override is exempt from this window.
    if (isOwnCheckIn) {
      const now = new Date();
      if (checkIn.activity.startDate <= now) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Cannot cancel check-in. The activity has already started.',
        });
      }
    }

    // Delete the check-in and reverse the awarded points in one transaction.
    // ADR-001 / BUILD_PLAN.md Phase 7: a step-gated check-in may not have
    // been paid yet (pointsAwardedAt null) — only reverse if points were
    // actually awarded, otherwise a blind reversal writes a spurious
    // negative ledger entry. The reversal is dated to `pointsAwardedAt` —
    // the day the points were actually earned — NOT `checkedInAt`: for a
    // step-gated activity the award fires later (when the step delta clears
    // the goal), and the original award used that award-day as its
    // effectiveDate, so the reversal must match it for period leaderboards
    // to net to zero. (Attendance-only: pointsAwardedAt ≈ checkedInAt, so
    // this is unchanged for that path.) Reverse points on the check-in's
    // own owner — not the caller, who may be an admin undoing someone
    // else's check-in.
    const wasPaid = Boolean(checkIn.pointsAwardedAt);
    await prisma.$transaction(async (tx) => {
      await tx.checkIn.delete({ where: { id } });
      if (wasPaid) {
        await applyPoints(tx, {
          userId: checkIn.userId,
          amount: -(checkIn.activity.points || 0),
          reason: 'CHECKIN_CANCELLED',
          effectiveDate: thaiDayTag(checkIn.pointsAwardedAt),
          refId: checkIn.activity.id,
        });
      }
    });

    return res.status(200).json({
      success: true,
      data: null,
      message: `Check-in to "${checkIn.activity.title}" cancelled successfully.${wasPaid && checkIn.activity.points ? ` -${checkIn.activity.points} points.` : ''}`,
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
