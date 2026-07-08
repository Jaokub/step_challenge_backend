import prisma from '../config/prisma.js';
import { generateUniqueCode, generateGroupInviteQR } from '../services/qrcode.service.js';

/**
 * @module GroupController
 * @description Controller for group management operations
 */

/**
 * List all groups the current user belongs to, with member count
 * @route GET /api/groups
 */
export const getGroups = async (req, res) => {
  try {
    const userId = req.user.id;

    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      include: {
        group: {
          include: {
            _count: {
              select: { members: true },
            },
            createdBy: {
              select: { id: true, fullName: true, avatarUrl: true },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const groups = memberships.map((membership) => ({
      id: membership.group.id,
      name: membership.group.name,
      description: membership.group.description,
      myRole: membership.role,
      memberCount: membership.group._count.members,
      createdBy: membership.group.createdBy,
      joinedAt: membership.joinedAt,
      createdAt: membership.group.createdAt,
    }));

    return res.json({
      success: true,
      data: groups,
      message: 'Groups retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch groups',
    });
  }
};

/**
 * Get group details with members list
 * @route GET /api/groups/:id
 */
export const getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const group = await prisma.appGroup.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: { id: true, fullName: true, email: true, avatarUrl: true },
        },
        members: {
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
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        },
        _count: {
          select: { members: true },
        },
        parentGroup: {
          select: { id: true, name: true },
        },
        childGroups: {
          select: { id: true, name: true, _count: { select: { members: true } } },
        },
      },
    });

    if (!group) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Group not found',
      });
    }

    // Membership already verified by requireGroupMember middleware.
    const result = {
      id: group.id,
      name: group.name,
      description: group.description,
      qrInviteCode: group.qrInviteCode,
      memberCount: group._count.members,
      createdBy: group.createdBy,
      createdAt: group.createdAt,
      parentGroupId: group.parentGroupId,
      parentGroup: group.parentGroup,
      childGroups: group.childGroups.map((c) => ({
        id: c.id,
        name: c.name,
        memberCount: c._count.members,
      })),
      members: group.members.map((m) => ({
        id: m.id,
        role: m.role,
        joinedAt: m.joinedAt,
        user: m.user,
      })),
    };

    return res.json({
      success: true,
      data: result,
      message: 'Group details retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching group:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch group details',
    });
  }
};

/**
 * Create a new group with auto-generated invite code, creator added as OWNER
 * @route POST /api/groups
 */
export const createGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description } = req.body;

    // Generate a unique invite code, retrying on collision
    let inviteCode;
    let isUnique = false;
    while (!isUnique) {
      inviteCode = generateUniqueCode();
      const existing = await prisma.appGroup.findUnique({
        where: { qrInviteCode: inviteCode },
      });
      if (!existing) {
        isUnique = true;
      }
    }

    const group = await prisma.$transaction(async (tx) => {
      // Create the group
      const newGroup = await tx.appGroup.create({
        data: {
          name,
          description: description || null,
          qrInviteCode: inviteCode,
          createdById: userId,
        },
      });

      // Add creator as OWNER
      await tx.groupMember.create({
        data: {
          groupId: newGroup.id,
          userId,
          role: 'OWNER',
        },
      });

      return newGroup;
    });

    // Fetch the created group with full details
    const createdGroup = await prisma.appGroup.findUnique({
      where: { id: group.id },
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true },
        },
        _count: {
          select: { members: true },
        },
      },
    });

    return res.status(201).json({
      success: true,
      data: createdGroup,
      message: 'Group created successfully',
    });
  } catch (error) {
    console.error('Error creating group:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to create group',
    });
  }
};

/**
 * Update group name/description. Only OWNER/ADMIN can update.
 * @route PUT /api/groups/:id
 */
export const updateGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    // Role check (OWNER/ADMIN) handled by requireGroupMember middleware.
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;

    const updatedGroup = await prisma.appGroup.update({
      where: { id },
      data: updateData,
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true },
        },
        _count: {
          select: { members: true },
        },
      },
    });

    return res.json({
      success: true,
      data: updatedGroup,
      message: 'Group updated successfully',
    });
  } catch (error) {
    console.error('Error updating group:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Group not found',
      });
    }
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to update group',
    });
  }
};

/**
 * Delete a group. Only the OWNER can delete.
 * @route DELETE /api/groups/:id
 */
export const deleteGroup = async (req, res) => {
  try {
    const { id } = req.params;

    // OWNER role check handled by requireGroupMember middleware.
    // Delete all members first, then the group (in a transaction)
    await prisma.$transaction(async (tx) => {
      await tx.groupMember.deleteMany({ where: { groupId: id } });
      await tx.appGroup.delete({ where: { id } });
    });

    return res.json({
      success: true,
      data: null,
      message: 'Group deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting group:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Group not found',
      });
    }
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to delete group',
    });
  }
};

/**
 * Join a group using a QR invite code
 * @route POST /api/groups/join
 */
export const joinByQR = async (req, res) => {
  try {
    const userId = req.user.id;
    const { inviteCode } = req.body;

    // Find group by invite code
    const group = await prisma.appGroup.findUnique({
      where: { qrInviteCode: inviteCode },
    });

    if (!group) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Invalid invite code. Group not found.',
      });
    }

    // Check if user is already a member
    const existingMembership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: { groupId: group.id, userId },
      },
    });

    if (existingMembership) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'You are already a member of this group',
      });
    }

    // Add user as MEMBER
    const membership = await prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId,
        role: 'MEMBER',
      },
      include: {
        group: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        groupId: membership.group.id,
        groupName: membership.group.name,
        role: membership.role,
        joinedAt: membership.joinedAt,
      },
      message: `Successfully joined group "${membership.group.name}"`,
    });
  } catch (error) {
    console.error('Error joining group:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to join group',
    });
  }
};

/**
 * Remove a member from a group. OWNER/ADMIN can remove members, but not other OWNER/ADMINs.
 * @route DELETE /api/groups/:id/members/:userId
 */
export const removeMember = async (req, res) => {
  try {
    const { id: groupId, userId: targetUserId } = req.params;
    const currentUserId = req.user.id;

    // Caller's OWNER/ADMIN role verified by requireGroupMember middleware.
    // Cannot remove yourself via this endpoint
    if (currentUserId === targetUserId) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Use the leave endpoint to remove yourself from the group',
      });
    }

    // Get target user's membership
    const targetMembership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: { groupId, userId: targetUserId },
      },
    });

    if (!targetMembership) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User is not a member of this group',
      });
    }

    // Cannot remove OWNER or ADMIN
    if (['OWNER', 'ADMIN'].includes(targetMembership.role)) {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'Cannot remove an owner or admin from the group',
      });
    }

    await prisma.groupMember.delete({
      where: {
        groupId_userId: { groupId, userId: targetUserId },
      },
    });

    return res.json({
      success: true,
      data: null,
      message: 'Member removed successfully',
    });
  } catch (error) {
    console.error('Error removing member:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to remove member',
    });
  }
};

/**
 * List all members of a group with their roles
 * @route GET /api/groups/:id/members
 */
export const getGroupMembers = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    // Membership verified by requireGroupMember middleware.
    const members = await prisma.groupMember.findMany({
      where: { groupId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            department: true,
            avatarUrl: true,
            totalPoints: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });

    const result = members.map((m) => ({
      id: m.id,
      role: m.role,
      joinedAt: m.joinedAt,
      user: m.user,
    }));

    return res.json({
      success: true,
      data: result,
      message: 'Group members retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching group members:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch group members',
    });
  }
};

/**
 * Generate and return a QR code image (data URL) for the group's invite code
 * @route GET /api/groups/:id/qrcode
 */
export const getGroupQRCode = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    // Membership verified by requireGroupMember middleware.
    const group = await prisma.appGroup.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, qrInviteCode: true },
    });

    if (!group) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Group not found',
      });
    }

    const qrCodeDataURL = await generateGroupInviteQR(group.id, group.qrInviteCode);

    return res.json({
      success: true,
      data: {
        groupId: group.id,
        groupName: group.name,
        inviteCode: group.qrInviteCode,
        qrCode: qrCodeDataURL,
      },
      message: 'QR code generated successfully',
    });
  } catch (error) {
    console.error('Error generating group QR code:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to generate QR code',
    });
  }
};

/**
 * Leave a group. OWNER cannot leave (must transfer ownership or delete group).
 * @route POST /api/groups/:id/leave
 */
export const leaveGroup = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const userId = req.user.id;

    // Membership verified by requireGroupMember middleware (404 if not a member).
    const membership = req.groupMembership;

    if (membership.role === 'OWNER') {
      return res.status(403).json({
        success: false,
        data: null,
        message: 'Group owner cannot leave. Transfer ownership or delete the group instead.',
      });
    }

    await prisma.groupMember.delete({
      where: {
        groupId_userId: { groupId, userId },
      },
    });

    return res.json({
      success: true,
      data: null,
      message: 'You have left the group',
    });
  } catch (error) {
    console.error('Error leaving group:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to leave group',
    });
  }
};
