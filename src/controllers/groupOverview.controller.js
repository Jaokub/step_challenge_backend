import { getGroupOwnOverview, getSiblingOverviews } from '../services/groupOverview.service.js';

/**
 * @module GroupOverviewController
 * @description Hierarchy-aware group stat endpoints. Split out from
 * group.controller.js to keep both files under the 200-line convention.
 */

/**
 * Own overall stats + full ranking + top3/top5 for a group. Caller must be
 * a member of the group itself, or a member of its parent group (ancestor).
 * requireGroupVisibility(['self', 'ancestor']) middleware enforces this.
 * @route GET /api/groups/:id/overview
 */
export const getGroupOverview = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { startDate, endDate } = req.query;

    const overview = await getGroupOwnOverview(groupId, startDate, endDate);

    return res.json({
      success: true,
      data: { groupId, ...overview },
      message: 'Group overview retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching group overview:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch group overview',
    });
  }
};

/**
 * Sibling groups' overall stats only (never their member ranking). Caller
 * must be a member of the group itself, or a member of its parent group.
 * requireGroupVisibility(['self', 'ancestor']) middleware enforces this.
 * @route GET /api/groups/:id/siblings
 */
export const getGroupSiblings = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const { startDate, endDate } = req.query;

    // req.groupNode is attached by requireGroupVisibility.
    const parentGroupId = req.groupNode?.parentGroupId ?? null;
    const siblings = await getSiblingOverviews(groupId, parentGroupId, startDate, endDate);

    return res.json({
      success: true,
      data: siblings,
      message: 'Sibling group stats retrieved successfully',
    });
  } catch (error) {
    console.error('Error fetching sibling groups:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Failed to fetch sibling group stats',
    });
  }
};
