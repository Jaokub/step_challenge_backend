import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth.js';
import { requireGroupMember, requireGroupVisibility } from '../middleware/groupAuth.js';
import { validate } from '../middleware/validate.js';
import {
  getGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  joinByQR,
  removeMember,
  getGroupMembers,
  getGroupQRCode,
  leaveGroup,
} from '../controllers/group.controller.js';
import { getGroupOverview, getGroupSiblings } from '../controllers/groupOverview.controller.js';
import {
  getParentCandidates,
  requestParent,
  listIncomingRequests,
  approveRequest,
  denyRequest,
  transferCoordinator,
  getAdminTree,
} from '../controllers/groupHierarchy.controller.js';

const router = Router();

/**
 * @route GET /api/groups/admin/tree
 * @desc Full group hierarchy (god-mode) — every root group with its
 *       children and any pending parent-requests nested under the
 *       requested parent (BUILD_PLAN.md Phase 5, mockup frame 6).
 * @access Private (Faculty Admin only)
 */
router.get('/admin/tree', authenticate, requireRole('ADMIN'), getAdminTree);

/**
 * @route GET /api/groups
 * @desc List all groups the current user belongs to
 * @access Private
 */
router.get('/', authenticate, getGroups);

/**
 * @route POST /api/groups
 * @desc Create a new group
 * @access Private
 */
router.post(
  '/',
  authenticate,
  validate([
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Group name is required')
      .isLength({ max: 100 })
      .withMessage('Group name must be at most 100 characters'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description must be at most 500 characters'),
  ]),
  createGroup
);

/**
 * @route POST /api/groups/join
 * @desc Join a group using QR invite code
 * @access Private
 */
router.post(
  '/join',
  authenticate,
  validate([
    body('inviteCode')
      .trim()
      .notEmpty()
      .withMessage('Invite code is required'),
  ]),
  joinByQR
);

/**
 * @route GET /api/groups/:id
 * @desc Get group details with members list
 * @access Private
 */
router.get('/:id', authenticate, requireGroupMember(), getGroupById);

/**
 * @route PUT /api/groups/:id
 * @desc Update group name/description
 * @access Private (OWNER/ADMIN only)
 */
router.put(
  '/:id',
  authenticate,
  requireGroupMember({
    roles: ['OWNER', 'ADMIN'],
    roleMessage: 'Only group owners and admins can update group details',
  }),
  updateGroup
);

/**
 * @route DELETE /api/groups/:id
 * @desc Delete a group
 * @access Private (OWNER only)
 */
router.delete(
  '/:id',
  authenticate,
  requireGroupMember({
    roles: ['OWNER'],
    roleMessage: 'Only the group owner can delete the group',
  }),
  deleteGroup
);

/**
 * @route DELETE /api/groups/:id/members/:userId
 * @desc Remove a member from a group
 * @access Private (OWNER/ADMIN only)
 */
router.delete(
  '/:id/members/:userId',
  authenticate,
  requireGroupMember({
    roles: ['OWNER', 'ADMIN'],
    roleMessage: 'Only group owners and admins can remove members',
  }),
  removeMember
);

/**
 * @route GET /api/groups/:id/members
 * @desc List all members of a group
 * @access Private
 */
router.get('/:id/members', authenticate, requireGroupMember(), getGroupMembers);

/**
 * @route GET /api/groups/:id/qrcode
 * @desc Generate and return QR code for group invite
 * @access Private
 */
router.get('/:id/qrcode', authenticate, requireGroupMember(), getGroupQRCode);

/**
 * @route POST /api/groups/:id/leave
 * @desc Leave a group
 * @access Private
 */
router.post(
  '/:id/leave',
  authenticate,
  requireGroupMember({ notMemberStatus: 404 }),
  leaveGroup
);

/**
 * @route GET /api/groups/:id/overview
 * @desc Own overall stats + full ranking + top3/top5 for a group.
 * @access Private (members of the group, or members of its parent group)
 */
router.get(
  '/:id/overview',
  authenticate,
  requireGroupVisibility(['self', 'ancestor']),
  getGroupOverview
);

/**
 * @route GET /api/groups/:id/siblings
 * @desc Sibling groups' overall stats only (never their member ranking).
 * @access Private (members of the group, or members of its parent group)
 */
router.get(
  '/:id/siblings',
  authenticate,
  requireGroupVisibility(['self', 'ancestor']),
  getGroupSiblings
);

/**
 * @route GET /api/groups/:id/parent-candidates
 * @desc Root groups a coordinator can request as :id's parent (mockup
 *       frame 14 picker sheet).
 * @access Private (OWNER of :id; Faculty Admin bypasses)
 */
router.get(
  '/:id/parent-candidates',
  authenticate,
  requireGroupMember({ roles: ['OWNER'], roleMessage: 'Only the group coordinator can request a parent group' }),
  getParentCandidates
);

/**
 * @route POST /api/groups/:id/parent-request
 * @desc Request :id to become a child of body.parentGroupId. Needs the
 *       target parent's coordinator (or an admin) to approve.
 * @access Private (OWNER of :id)
 */
router.post(
  '/:id/parent-request',
  authenticate,
  requireGroupMember({ roles: ['OWNER'], roleMessage: 'Only the group coordinator can request a parent group' }),
  validate([body('parentGroupId').trim().notEmpty().withMessage('parentGroupId is required')]),
  requestParent
);

/**
 * @route GET /api/groups/:id/parent-requests
 * @desc Incoming requests where :id is the prospective parent.
 * @access Private (OWNER of :id; Faculty Admin bypasses)
 */
router.get(
  '/:id/parent-requests',
  authenticate,
  requireGroupMember({ roles: ['OWNER'], roleMessage: 'Only the group coordinator can view incoming requests' }),
  listIncomingRequests
);

/**
 * @route POST /api/groups/:id/parent-requests/:requestId/approve
 * @access Private (OWNER of :id; Faculty Admin bypasses = override-approve)
 */
router.post(
  '/:id/parent-requests/:requestId/approve',
  authenticate,
  requireGroupMember({ roles: ['OWNER'], roleMessage: 'Only the group coordinator can resolve requests' }),
  approveRequest
);

/**
 * @route POST /api/groups/:id/parent-requests/:requestId/deny
 * @access Private (OWNER of :id; Faculty Admin bypasses)
 */
router.post(
  '/:id/parent-requests/:requestId/deny',
  authenticate,
  requireGroupMember({ roles: ['OWNER'], roleMessage: 'Only the group coordinator can resolve requests' }),
  denyRequest
);

/**
 * @route POST /api/groups/:id/transfer-coordinator
 * @desc Move the OWNER role to body.userId. Coordinator-initiated (target
 *       must already be a member) or admin-override (target need not be).
 *       Authorization lives in the controller, not requireGroupMember —
 *       an admin transferring a group they don't belong to would 404 there.
 * @access Private (current OWNER of :id, or Faculty Admin)
 */
router.post(
  '/:id/transfer-coordinator',
  authenticate,
  validate([body('userId').trim().notEmpty().withMessage('userId is required')]),
  transferCoordinator
);

export default router;
