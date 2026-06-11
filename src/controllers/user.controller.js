import prisma from '../config/prisma.js';
import { sanitizeUser } from '../services/userSanitizer.service.js';

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
    const { fullName, nickname, department, avatarUrl } = req.body;

    // Build update data — only include fields that were provided
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (nickname !== undefined) updateData.nickname = nickname;
    if (department !== undefined) updateData.department = department;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'No fields to update. Provide at least one of: fullName, nickname, department, avatarUrl.',
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

/**
 * GET /users/search
 * Search users by name or email (excluding self) to add as friends.
 * Query params: q (search query).
 */
export async function searchUsers(req, res) {
  try {
    const q = req.query.q?.trim();
    if (!q) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Search query "q" is required.',
      });
    }

    const userId = req.user.id;

    // Search users by email or fullName, excluding the current user
    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        department: true,
        avatarUrl: true,
      },
      take: 20, // Limit search results to 20
    });

    return res.status(200).json({
      success: true,
      data: users,
      message: 'Search successful.',
    });
  } catch (error) {
    console.error('SearchUsers error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}
