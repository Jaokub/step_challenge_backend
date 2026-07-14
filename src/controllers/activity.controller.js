import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma.js';
import { getMyParticipation } from '../services/activityParticipant.service.js';

/**
 * @desc    List activities with filters, search, and pagination
 * @route   GET /api/activities
 * @access  Private
 */
export const getActivities = async (req, res) => {
  try {
    const {
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where = {};

    // Filter by status
    if (status) {
      const validStatuses = ['UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'];
      if (validStatuses.includes(status.toUpperCase())) {
        where.status = status.toUpperCase();
      }
    } else {
      // By default, exclude cancelled activities
      where.status = { not: 'CANCELLED' };
    }

    // Search by title or description
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Filter by date range
    if (startDate) {
      where.startDate = { ...where.startDate, gte: new Date(startDate) };
    }
    if (endDate) {
      where.endDate = { ...where.endDate, lte: new Date(endDate) };
    }

    const [activities, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { startDate: 'desc' },
        include: {
          createdBy: {
            select: { id: true, fullName: true, department: true, avatarUrl: true },
          },
          _count: {
            select: { checkIns: true, activityParticipants: true },
          },
        },
      }),
      prisma.activity.count({ where }),
    ]);

    const activitiesWithCount = activities.map((activity) => ({
      ...activity,
      // Checked-in count (existing meaning, unchanged) vs. registered-only
      // count (ActivityParticipant — enrolled but not necessarily checked
      // in yet; BUILD_PLAN.md Phase 4). Keep both distinct on the response.
      participantCount: activity._count.checkIns,
      registeredCount: activity._count.activityParticipants,
      _count: undefined,
    }));

    return res.status(200).json({
      success: true,
      data: {
        activities: activitiesWithCount,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      message: 'Activities retrieved successfully',
    });
  } catch (error) {
    console.error('getActivities error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve activities',
    });
  }
};

/**
 * @desc    Get single activity with participants and check-in status
 * @route   GET /api/activities/:id
 * @access  Private
 */
export const getActivityById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const activity = await prisma.activity.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: { id: true, fullName: true, department: true, avatarUrl: true },
        },
        checkIns: {
          include: {
            user: {
              select: { id: true, fullName: true, department: true, avatarUrl: true },
            },
          },
          orderBy: { checkedInAt: 'desc' },
        },
        _count: {
          select: { checkIns: true, activityParticipants: true },
        },
      },
    });

    if (!activity) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Activity not found',
      });
    }

    // Check if current user has checked in
    const userCheckIn = activity.checkIns.find((ci) => ci.userId === userId);

    // Registration-only cascade (BUILD_PLAN.md Phase 4) — separate from
    // check-ins/points. Tells the mobile "your group already joined" badge
    // and drives whether the "leave activity" action shows.
    const participation = await getMyParticipation(id, userId);

    const result = {
      ...activity,
      // Checked-in count vs. registered-only count — distinct concepts, see
      // getActivities() above for the same split.
      participantCount: activity._count.checkIns,
      registeredCount: activity._count.activityParticipants,
      isCheckedIn: !!userCheckIn,
      userCheckIn: userCheckIn || null,
      participants: activity.checkIns.map((ci) => ({
        ...ci.user,
        checkedInAt: ci.checkedInAt,
        method: ci.method,
      })),
      myParticipation: participation
        ? { groupId: participation.groupId, groupName: participation.group?.name ?? null }
        : null,
      _count: undefined,
      checkIns: undefined,
    };

    return res.status(200).json({
      success: true,
      data: result,
      message: 'Activity retrieved successfully',
    });
  } catch (error) {
    console.error('getActivityById error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve activity',
    });
  }
};

/**
 * @desc    Create a new activity (Admin only)
 * @route   POST /api/activities
 * @access  Private/Admin
 */
export const createActivity = async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      startDate,
      endDate,
      maxParticipants,
      imageUrl,
      points,
      expectedSteps,
      totalDistance,
    } = req.body;

    // Validate required fields
    if (!title || !location || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'title, location, startDate and endDate are required',
      });
    }

    // At least one target (expected steps or total distance) must be provided
    const hasSteps = expectedSteps !== undefined && expectedSteps !== null && expectedSteps !== '';
    const hasDistance = totalDistance !== undefined && totalDistance !== null && totalDistance !== '';
    if (!hasSteps && !hasDistance) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Provide at least one target: expectedSteps or totalDistance',
      });
    }

    // endDate must not be before startDate
    if (new Date(endDate) < new Date(startDate)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'endDate cannot be before startDate',
      });
    }

    // Generate a unique QR code
    const qrCode = uuidv4();

    const activity = await prisma.activity.create({
      data: {
        title,
        description: description || '',
        location,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        qrCode,
        createdById: req.user.id,
        status: 'UPCOMING',
        maxParticipants: maxParticipants ? parseInt(maxParticipants, 10) : null,
        imageUrl: imageUrl || null,
        points: points ? parseInt(points, 10) : 0,
        expectedSteps: hasSteps ? parseInt(expectedSteps, 10) : null,
        totalDistance: hasDistance ? parseFloat(totalDistance) : null,
      },
      include: {
        createdBy: {
          select: { id: true, fullName: true, department: true, avatarUrl: true },
        },
      },
    });

    return res.status(201).json({
      success: true,
      data: activity,
      message: 'Activity created successfully',
    });
  } catch (error) {
    console.error('createActivity error:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'A QR code collision occurred. Please try again.',
      });
    }
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to create activity',
    });
  }
};

/**
 * @desc    Update an activity (Admin only)
 * @route   PUT /api/activities/:id
 * @access  Private/Admin
 */
export const updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      location,
      startDate,
      endDate,
      status,
      maxParticipants,
      imageUrl,
      points,
      expectedSteps,
      totalDistance,
    } = req.body;

    // Check if activity exists
    const existing = await prisma.activity.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Activity not found',
      });
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (location !== undefined) updateData.location = location;
    if (startDate !== undefined) updateData.startDate = new Date(startDate);
    if (endDate !== undefined) updateData.endDate = new Date(endDate);
    if (status !== undefined) {
      const validStatuses = ['UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          data: null,
          message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
      }
      updateData.status = status;
    }
    if (maxParticipants !== undefined) updateData.maxParticipants = maxParticipants ? parseInt(maxParticipants, 10) : null;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (points !== undefined) updateData.points = parseInt(points, 10);
    if (expectedSteps !== undefined) updateData.expectedSteps = (expectedSteps === null || expectedSteps === '') ? null : parseInt(expectedSteps, 10);
    if (totalDistance !== undefined) updateData.totalDistance = (totalDistance === null || totalDistance === '') ? null : parseFloat(totalDistance);

    const activity = await prisma.activity.update({
      where: { id },
      data: updateData,
      include: {
        createdBy: {
          select: { id: true, fullName: true, department: true, avatarUrl: true },
        },
        _count: {
          select: { checkIns: true, activityParticipants: true },
        },
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        ...activity,
        participantCount: activity._count.checkIns,
        registeredCount: activity._count.activityParticipants,
        _count: undefined,
      },
      message: 'Activity updated successfully',
    });
  } catch (error) {
    console.error('updateActivity error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to update activity',
    });
  }
};

/**
 * @desc    Soft delete an activity by setting status to CANCELLED (Admin only)
 * @route   DELETE /api/activities/:id
 * @access  Private/Admin
 */
export const deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.activity.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Activity not found',
      });
    }

    if (existing.status === 'CANCELLED') {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Activity is already cancelled',
      });
    }

    const activity = await prisma.activity.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    return res.status(200).json({
      success: true,
      data: activity,
      message: 'Activity cancelled successfully',
    });
  } catch (error) {
    console.error('deleteActivity error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to delete activity',
    });
  }
};

/**
 * @desc    Get activities the current user has checked into
 * @route   GET /api/activities/my
 * @access  Private
 */
export const getMyActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where = {
      userId,
    };

    const [checkIns, total] = await Promise.all([
      prisma.checkIn.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { checkedInAt: 'desc' },
        include: {
          activity: {
            include: {
              createdBy: {
                select: { id: true, fullName: true, department: true, avatarUrl: true },
              },
              _count: {
                select: { checkIns: true, activityParticipants: true },
              },
            },
          },
        },
      }),
      prisma.checkIn.count({ where }),
    ]);

    const activities = checkIns.map((ci) => ({
      ...ci.activity,
      participantCount: ci.activity._count.checkIns,
      registeredCount: ci.activity._count.activityParticipants,
      _count: undefined,
      checkedInAt: ci.checkedInAt,
      checkInMethod: ci.method,
    }));

    return res.status(200).json({
      success: true,
      data: {
        activities,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      message: 'Your activities retrieved successfully',
    });
  } catch (error) {
    console.error('getMyActivities error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to retrieve your activities',
    });
  }
};
