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
 * PATCH /users/:id/role
 * Admin only — grant or revoke ADMIN. Gap #5 (BUILD_PLAN.md Phase 2).
 * Guards against demoting the last remaining admin.
 */
export async function updateUserRole(req, res) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User not found.',
      });
    }

    if (targetUser.role === 'ADMIN' && role === 'STAFF') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return res.status(409).json({
          success: false,
          data: null,
          message: 'Cannot revoke the last remaining admin.',
        });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role },
    });

    return res.status(200).json({
      success: true,
      data: { user: sanitizeUser(updatedUser) },
      message: 'User role updated successfully.',
    });
  } catch (error) {
    console.error('UpdateUserRole error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * GET /users/search
 * Search users by name, email, or ID (excluding self) to add as friends.
 * `q` is now optional — an empty/omitted query returns a paginated "browse
 * all colleagues" list instead of 400ing, which powers the add-friend
 * sheet's "ค้นหา" tab before anything has been typed (it used to show a
 * static "type to search" placeholder with no way to browse).
 * Every returned user carries `friendshipStatus` relative to the caller
 * (NONE / PENDING_SENT / PENDING_RECEIVED / FRIENDS) so the client can
 * render the right button state (Add / Pending / Already friends) without
 * a second round-trip.
 * Query params: q (optional), page (default 1), limit (default 20, max 50).
 */
export async function searchUsers(req, res) {
  try {
    const q = req.query.q?.trim() || '';
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    const where = {
      id: { not: userId },
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { id: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          department: true,
          avatarUrl: true,
        },
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    const friendshipStatusById = await getFriendshipStatuses(userId, users.map((u) => u.id));

    return res.status(200).json({
      success: true,
      data: {
        users: users.map((u) => ({
          ...u,
          friendshipStatus: friendshipStatusById[u.id] ?? 'NONE',
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(Math.ceil(total / limit), 1),
        },
      },
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

/**
 * Batch-computes each candidate's relationship to `userId` in a single
 * query — avoids an N+1 (one Friendship lookup per row) on a list endpoint.
 * A candidate with no Friendship row at all is left out of the returned
 * map; callers should default missing ids to 'NONE'.
 */
async function getFriendshipStatuses(userId, candidateIds) {
  if (candidateIds.length === 0) return {};

  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userId, friendId: { in: candidateIds } },
        { userId: { in: candidateIds }, friendId: userId },
      ],
    },
  });

  const statusById = {};
  for (const f of friendships) {
    const otherId = f.userId === userId ? f.friendId : f.userId;
    if (f.status === 'ACCEPTED') {
      statusById[otherId] = 'FRIENDS';
    } else if (f.userId === userId) {
      // I sent this request — still waiting on them.
      statusById[otherId] = 'PENDING_SENT';
    } else {
      // They sent me a request I haven't responded to yet. Sending a
      // request back from the client's "Add" button will auto-accept it
      // (see friend.controller.js sendFriendRequest), so this is left
      // clickable rather than disabled.
      statusById[otherId] = 'PENDING_RECEIVED';
    }
  }
  return statusById;
}
