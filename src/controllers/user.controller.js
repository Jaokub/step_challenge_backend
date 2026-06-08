import prisma from '../config/prisma.js';

/**
 * Strip sensitive fields from a user object before returning it.
 * @param {Object} user - The Prisma user record.
 * @returns {Object} User object without passwordHash.
 */
function sanitizeUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

/**
 * GET /users/profile/:id
 * Get a user's profile by ID, including aggregated stats.
 */
export async function getProfile(req, res) {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User not found.',
      });
    }

    // Aggregate stats in parallel
    const [totalCheckIns, totalActivities, totalGroups] = await Promise.all([
      prisma.checkIn.count({ where: { userId: id } }),
      prisma.activity.count({ where: { createdById: id } }),
      prisma.groupMember.count({ where: { userId: id } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        user: sanitizeUser(user),
        stats: {
          totalCheckIns,
          totalActivities,
          totalGroups,
        },
      },
      message: 'Profile retrieved successfully.',
    });
  } catch (error) {
    console.error('GetProfile error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * PUT /users/profile
 * Update the authenticated user's own profile.
 */
export async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const { fullName, department, avatarUrl } = req.body;

    // Build update data — only include fields that were provided
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (department !== undefined) updateData.department = department;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'No fields to update. Provide at least one of: fullName, department, avatarUrl.',
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return res.status(200).json({
      success: true,
      data: { user: sanitizeUser(updatedUser) },
      message: 'Profile updated successfully.',
    });
  } catch (error) {
    console.error('UpdateProfile error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * GET /users/leaderboard
 * Get users ranked by totalPoints with pagination.
 * Query params: limit (default 10), offset (default 0).
 */
export async function getLeaderboard(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        orderBy: { totalPoints: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          fullName: true,
          department: true,
          avatarUrl: true,
          totalPoints: true,
        },
      }),
      prisma.user.count(),
    ]);

    // Add rank based on offset position
    const rankedUsers = users.map((user, index) => ({
      rank: offset + index + 1,
      ...user,
    }));

    return res.status(200).json({
      success: true,
      data: {
        leaderboard: rankedUsers,
        pagination: {
          total,
          limit,
          offset,
        },
      },
      message: 'Leaderboard retrieved successfully.',
    });
  } catch (error) {
    console.error('GetLeaderboard error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * GET /users/
 * Admin only — list all users with pagination and optional search.
 * Query params: limit (default 20), offset (default 0), search (optional).
 */
export async function getAllUsers(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = req.query.search?.trim() || '';

    // Build where clause — search across fullName, email, and department
    const where = search
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { department: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        users: users.map(sanitizeUser),
        pagination: {
          total,
          limit,
          offset,
        },
      },
      message: 'Users retrieved successfully.',
    });
  } catch (error) {
    console.error('GetAllUsers error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}
