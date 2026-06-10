import prisma from '../config/prisma.js';

/**
 * Strip sensitive fields from a user object before returning it.
 */
function sanitizeUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

/**
 * @desc    Send a friend request or accept an existing one
 * @route   POST /api/v1/friends/request
 * @access  Private
 */
export const sendFriendRequest = async (req, res) => {
  try {
    const { friendId } = req.body;
    const userId = req.user.id;

    if (userId === friendId) {
      return res.status(400).json({ success: false, message: 'You cannot add yourself as a friend' });
    }

    const friend = await prisma.user.findUnique({ where: { id: friendId } });
    if (!friend) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if friendship already exists in either direction
    const existingFriendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId }
        ]
      }
    });

    if (existingFriendship) {
      if (existingFriendship.status === 'ACCEPTED') {
        return res.status(400).json({ success: false, message: 'You are already friends' });
      }

      if (existingFriendship.userId === userId) {
        return res.status(400).json({ success: false, message: 'Friend request already sent' });
      }

      // If they sent a request to us, and we are sending one back, just accept it
      const updatedFriendship = await prisma.friendship.update({
        where: { id: existingFriendship.id },
        data: { status: 'ACCEPTED' },
      });

      return res.status(200).json({
        success: true,
        data: updatedFriendship,
        message: 'Friend request accepted'
      });
    }

    // Create new pending request
    const newFriendship = await prisma.friendship.create({
      data: {
        userId,
        friendId,
        status: 'PENDING',
      }
    });

    return res.status(201).json({
      success: true,
      data: newFriendship,
      message: 'Friend request sent'
    });

  } catch (error) {
    console.error('sendFriendRequest error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send friend request' });
  }
};

/**
 * @desc    Accept a friend request
 * @route   PUT /api/v1/friends/request/:id/accept
 * @access  Private
 */
export const acceptFriendRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const friendship = await prisma.friendship.findUnique({ where: { id } });

    if (!friendship) {
      return res.status(404).json({ success: false, message: 'Friend request not found' });
    }

    // Only the receiver can accept
    if (friendship.friendId !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to accept this request' });
    }

    if (friendship.status === 'ACCEPTED') {
      return res.status(400).json({ success: false, message: 'Already accepted' });
    }

    const updatedFriendship = await prisma.friendship.update({
      where: { id },
      data: { status: 'ACCEPTED' },
    });

    return res.status(200).json({
      success: true,
      data: updatedFriendship,
      message: 'Friend request accepted'
    });

  } catch (error) {
    console.error('acceptFriendRequest error:', error);
    return res.status(500).json({ success: false, message: 'Failed to accept friend request' });
  }
};

/**
 * @desc    Reject a friend request or Unfriend
 * @route   DELETE /api/v1/friends/:id
 * @access  Private
 */
export const removeFriend = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const friendship = await prisma.friendship.findUnique({ where: { id } });

    if (!friendship) {
      return res.status(404).json({ success: false, message: 'Friendship or request not found' });
    }

    // Either party can remove the friendship
    if (friendship.userId !== userId && friendship.friendId !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to remove this' });
    }

    await prisma.friendship.delete({ where: { id } });

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Friend removed / Request cancelled'
    });

  } catch (error) {
    console.error('removeFriend error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove friend' });
  }
};

/**
 * @desc    Get list of accepted friends
 * @route   GET /api/v1/friends
 * @access  Private
 */
export const getFriendsList = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all friendships where user is either sender or receiver AND status is ACCEPTED
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId: userId },
          { friendId: userId }
        ]
      },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true, department: true, totalPoints: true } },
        friend: { select: { id: true, fullName: true, avatarUrl: true, department: true, totalPoints: true } }
      }
    });

    // Map the results to just return the friend's user object
    const friends = friendships.map(f => {
      // If we are the sender, the friend is `f.friend`
      // If we are the receiver, the friend is `f.user`
      return f.userId === userId ? f.friend : f.user;
    });

    return res.status(200).json({
      success: true,
      data: friends,
      message: 'Friends list retrieved successfully'
    });

  } catch (error) {
    console.error('getFriendsList error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve friends list' });
  }
};

/**
 * @desc    Get pending friend requests received by current user
 * @route   GET /api/v1/friends/requests
 * @access  Private
 */
export const getPendingRequests = async (req, res) => {
  try {
    const userId = req.user.id;

    const requests = await prisma.friendship.findMany({
      where: {
        friendId: userId,
        status: 'PENDING'
      },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true, department: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: requests,
      message: 'Pending requests retrieved successfully'
    });

  } catch (error) {
    console.error('getPendingRequests error:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve pending requests' });
  }
};
