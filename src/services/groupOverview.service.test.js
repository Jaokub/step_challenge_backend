import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';
import { thaiDayTag, thaiWeekStartTag, thaiMonthStartTag } from '../utils/thaiTime.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const {
  getGroupsPeriodSteps,
  getGroupPeriodStats,
  getSiblingOverviews,
  getChildRanking,
  getGroupOwnOverview,
  getHierarchyOverview,
} = await import('./groupOverview.service.js');

const USER = (id, name, totalPoints = 0) => ({
  id,
  fullName: name,
  avatarUrl: null,
  department: 'ENG',
  totalPoints,
});

describe('groupOverview.service (Phase 5.2 deferred tests)', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: `clear` wipes call history but leaves
    // queued `mockResolvedValueOnce` values in place, so an unconsumed value
    // from one test silently feeds the next. Harmless while every test
    // consumed exactly what it queued — and a nightmare the moment a change
    // shifts the call count, which ADR-003 did.
    vi.resetAllMocks();
    mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);

    // ADR-003 defaults. `getSubtreeGroups` walks downward with
    // `parentGroupId: { in: [...] }`; an empty result means "every group here
    // is a leaf", which is what most of these tests assume. Tests that DO want
    // descendants override with `wireTree` below.
    //
    // Note the ordering these rely on: `getChildGroups` / `getSiblingGroups`
    // run BEFORE the subtree walk, so the existing `mockResolvedValueOnce`
    // wiring for those still lands on the right call.
    mockPrisma.appGroup.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  /**
   * Describe the tree once as `{ parentId: [childId, ...] }` and serve BOTH
   * shapes of `appGroup.findMany` this module issues:
   *
   *   - `parentGroupId: 'x'`        → getChildGroups / getSiblingGroups
   *   - `parentGroupId: { in: [] }` → the getSubtreeGroups walk
   *
   * Wiring only one of them is how the first draft of the directOnlyMembers
   * tests went wrong: getChildGroups reported a child while the engine saw a
   * leaf, so a member of both parent and child looked like they were in no
   * sub-group at all.
   */
  const wireTree = (childrenByParentId) => {
    const childrenOf = (pid) =>
      (childrenByParentId[pid] ?? []).map((id) => ({ id, name: `name-${id}`, parentGroupId: pid }));

    mockPrisma.appGroup.findMany.mockImplementation(({ where }) => {
      const parent = where?.parentGroupId;
      if (parent?.in) return Promise.resolve(parent.in.flatMap(childrenOf)); // subtree walk
      return Promise.resolve(childrenOf(parent)); // child / sibling lookup
    });
  };

  describe('getGroupsPeriodSteps — fixed query count + window boundaries', () => {
    it('issues a FIXED number of queries regardless of group/member count (ADR-003)', async () => {
      // The N+1 guard, and the reason this engine exists as one batched call.
      // The group-detail screen asks for self + parent + every sibling + every
      // child at once, so anything per-group here multiplies on screen.
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 'u1' },
        { groupId: 'g1', userId: 'u2' },
        { groupId: 'g2', userId: 'u3' },
        { groupId: 'g2', userId: 'u4' },
        { groupId: 'g3', userId: 'u5' },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getGroupsPeriodSteps(['g1', 'g2', 'g3']);

      // One membership query, one user hydration, three window aggregations —
      // never one set per group.
      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(3);
      // The tree walk is bounded by depth, not by the number of roots: one
      // level query finds no children, so it stops.
      expect(mockPrisma.appGroup.findMany).toHaveBeenCalledTimes(1);
    });

    it('does not add queries as the tree gets deeper per root', async () => {
      // Same assertion from the other direction: three roots each two levels
      // deep still walk level-by-level across ALL roots together.
      wireTree({ g1: ['g1a'], g2: ['g2a'], g3: ['g3a'], g1a: ['g1b'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([]);

      await getGroupsPeriodSteps(['g1', 'g2', 'g3']);

      // Level 1 finds g1a/g2a/g3a, level 2 finds g1b, level 3 finds nothing.
      expect(mockPrisma.appGroup.findMany).toHaveBeenCalledTimes(3);
      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns zeroed stats for an empty groupIds list without querying', async () => {
      const result = await getGroupsPeriodSteps([]);
      expect(result.size).toBe(0);
      expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    });

    it('returns zeroed stats for a group with no members', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      const result = await getGroupsPeriodSteps(['empty-group']);
      expect(result.get('empty-group')).toEqual({
        today: { steps: 0, calories: 0, distanceKm: 0 },
        week: { steps: 0, calories: 0, distanceKm: 0 },
        month: { steps: 0, calories: 0, distanceKm: 0 },
        subtreeMemberCount: 0,
        members: [],
        directOnly: {
          today: { steps: 0, calories: 0, distanceKm: 0 },
          week: { steps: 0, calories: 0, distanceKm: 0 },
          month: { steps: 0, calories: 0, distanceKm: 0 },
          count: 0,
        },
      });
      // Bails before the window queries since there are no userIds to aggregate.
      expect(mockPrisma.healthRecord.groupBy).not.toHaveBeenCalled();
    });

    it('passes the correct Thai today/week/month window bounds to each of the three groupBy calls', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const now = new Date();
      await getGroupsPeriodSteps(['g1']);

      const calls = mockPrisma.healthRecord.groupBy.mock.calls.map((c) => c[0].where.recordDate);
      const [todayRange, weekRange, monthRange] = calls;

      const dayStart = thaiDayTag(now);
      expect(todayRange.gte.getTime()).toBe(dayStart.getTime());
      expect(weekRange.gte.getTime()).toBe(thaiWeekStartTag(now).getTime());
      expect(monthRange.gte.getTime()).toBe(thaiMonthStartTag(now).getTime());
      // All three share the same exclusive upper bound: start of tomorrow.
      expect(todayRange.lt.getTime()).toBe(weekRange.lt.getTime());
      expect(weekRange.lt.getTime()).toBe(monthRange.lt.getTime());
    });

    it('folds per-user sums into the correct group for each window independently', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 'u1' },
        { groupId: 'g2', userId: 'u2' },
      ]);
      // Call order for one group's Promise.all is [today, week, month].
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([{ userId: 'u1', _sum: { steps: 100, calories: 1, distanceKm: 0.1 } }]) // today
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 400, calories: 4, distanceKm: 0.4 } },
          { userId: 'u2', _sum: { steps: 200, calories: 2, distanceKm: 0.2 } },
        ]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 900, calories: 9, distanceKm: 0.9 } },
          { userId: 'u2', _sum: { steps: 500, calories: 5, distanceKm: 0.5 } },
        ]); // month

      const result = await getGroupsPeriodSteps(['g1', 'g2']);

      expect(result.get('g1').today.steps).toBe(100);
      expect(result.get('g1').week.steps).toBe(400);
      expect(result.get('g1').month.steps).toBe(900);
      expect(result.get('g2').today.steps).toBe(0); // u2 had no "today" record
      expect(result.get('g2').week.steps).toBe(200);
      expect(result.get('g2').month.steps).toBe(500);
      expect(result.get('g1').subtreeMemberCount).toBe(1);
      expect(result.get('g2').subtreeMemberCount).toBe(1);
    });
  });

  describe('getGroupPeriodStats — single-group wrapper', () => {
    it('returns the same shape as one entry of getGroupsPeriodSteps', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);
      const stats = await getGroupPeriodStats('g1');
      expect(stats).toHaveProperty('today');
      expect(stats).toHaveProperty('week');
      expect(stats).toHaveProperty('month');
      expect(stats).toHaveProperty('subtreeMemberCount', 1);
    });
  });

  describe('getSiblingOverviews / buildGroupPreview — Top-3 exposure (D1)', () => {
    it('exposes only 3 rows even when a sibling has more than 3 members', async () => {
      // Target group g2's parent is p1; siblings share p1. Since ADR-003 the
      // Top-3 is derived from the engine's member rows, so there is no longer
      // a second membership query from getGroupLeaderboard to wire.
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([{ id: 'g1', name: 'Sibling Group' }]); // getSiblingGroups
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'g1', userId: 'u1' },
        { groupId: 'g1', userId: 'u2' },
        { groupId: 'g1', userId: 'u3' },
        { groupId: 'g1', userId: 'u4' },
        { groupId: 'g1', userId: 'u5' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        USER('u1', 'A'),
        USER('u2', 'B'),
        USER('u3', 'C'),
        USER('u4', 'D'),
        USER('u5', 'E'),
      ]);
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 10, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 50, calories: 0, distanceKm: 0 } },
          { userId: 'u3', _sum: { steps: 30, calories: 0, distanceKm: 0 } },
          { userId: 'u4', _sum: { steps: 90, calories: 0, distanceKm: 0 } },
          { userId: 'u5', _sum: { steps: 20, calories: 0, distanceKm: 0 } },
        ]); // month

      const overviews = await getSiblingOverviews('g2', 'p1');

      expect(overviews).toHaveLength(1);
      expect(overviews[0].top3).toHaveLength(3);
      // Never the full ranking, and never the raw `ranking`/`members` fields —
      // a sibling sees stats plus a bounded preview, nothing more.
      expect(overviews[0].ranking).toBeUndefined();
      expect(overviews[0].members).toBeUndefined();
      // Sorted descending by real month steps: D(90) > B(50) > C(30).
      expect(overviews[0].top3.map((r) => r.name)).toEqual(['D', 'B', 'C']);
      expect(overviews[0].top3.map((r) => r.rank)).toEqual([1, 2, 3]);
    });

    it('builds the Top-3 without a per-group leaderboard query (ADR-003 N+1 fix)', async () => {
      // buildGroupPreview used to call getGroupLeaderboard once per group, so
      // a screen with N relation cards issued 2N extra queries. The engine now
      // supplies the member rows, so the count must not scale with siblings.
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([
        { id: 's1', name: 'S1' },
        { id: 's2', name: 'S2' },
        { id: 's3', name: 'S3' },
      ]); // getSiblingGroups
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 's1', userId: 'u1' },
        { groupId: 's2', userId: 'u2' },
        { groupId: 's3', userId: 'u3' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'A'), USER('u2', 'B'), USER('u3', 'C')]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const overviews = await getSiblingOverviews('g0', 'p1');

      expect(overviews).toHaveLength(3);
      // One membership query total, not one per sibling.
      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(3);
    });

    it('returns an empty array when the group has no parent (no siblings)', async () => {
      const overviews = await getSiblingOverviews('g1', null);
      expect(overviews).toEqual([]);
      expect(mockPrisma.appGroup.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getChildRanking', () => {
    it('ranks children by this-month steps descending with 1..N rank numbering', async () => {
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([
        { id: 'c1', name: 'Child Low' },
        { id: 'c2', name: 'Child High' },
      ]); // getChildGroups
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'c1', userId: 'u1' },
        { groupId: 'c2', userId: 'u2' },
      ]);
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 100, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 900, calories: 0, distanceKm: 0 } },
        ]); // month

      const { ranking } = await getChildRanking('parent-group');
      expect(ranking.map((r) => r.groupName)).toEqual(['Child High', 'Child Low']);
      expect(ranking.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('returns an empty ranking and zeroed stats for a group with no children', async () => {
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([]);
      const { ranking, stats } = await getChildRanking('leaf-group');
      expect(ranking).toEqual([]);
      expect(stats.month).toEqual({ steps: 0, calories: 0, distanceKm: 0 });
      expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getChildRanking — directOnlyMembers (ADR-003 decision 4)', () => {
    it('reports members of the group who are in none of its children', async () => {
      wireTree({ parent: ['c1'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'parent', userId: 'loner' },
        { groupId: 'c1', userId: 'u2' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('loner', 'Loner'), USER('u2', 'Child Member')]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'loner', _sum: { steps: 120, calories: 0, distanceKm: 0 } },
        { userId: 'u2', _sum: { steps: 400, calories: 0, distanceKm: 0 } },
      ]);

      const { directOnlyMembers } = await getChildRanking('parent');

      expect(directOnlyMembers.count).toBe(1);
      expect(directOnlyMembers.month.steps).toBe(120);
    });

    it('excludes someone who is in both the group and one of its children', async () => {
      // Otherwise the same person appears on a child row AND the leftover row
      // of the same list, which reads as a data bug.
      wireTree({ parent: ['c1'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'parent', userId: 'both' },
        { groupId: 'c1', userId: 'both' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('both', 'Both')]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'both', _sum: { steps: 900, calories: 0, distanceKm: 0 } },
      ]);

      const { directOnlyMembers } = await getChildRanking('parent');

      expect(directOnlyMembers.count).toBe(0);
      expect(directOnlyMembers.month.steps).toBe(0);
    });

    it('is zeroed for a group with no children at all', async () => {
      wireTree({});
      const { directOnlyMembers } = await getChildRanking('leaf-group');

      expect(directOnlyMembers.count).toBe(0);
      expect(directOnlyMembers.month).toEqual({ steps: 0, calories: 0, distanceKm: 0 });
    });

    it('costs no extra query — the group rides along in the batched call', async () => {
      wireTree({ parent: ['c1'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'c1', userId: 'u1' }]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'A')]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getChildRanking('parent');

      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(3);
    });
  });

  describe('getHierarchyOverview — children as per-group member previews', () => {
    it('returns one preview per child group with member-level Top-3, not a group-vs-group ranking', async () => {
      // No parent (parentGroupId null) so getSiblingGroups short-circuits to
      // [] without a query — keeps this test focused on the children path.
      mockPrisma.appGroup.findUnique.mockResolvedValueOnce({ id: 'g1', parentGroupId: null }); // group.scope lookup
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([{ id: 'c1', name: 'Child A' }]); // getChildGroups

      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'c1', userId: 'u1' },
        { groupId: 'c1', userId: 'u2' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'Alice'), USER('u2', 'Bob')]);

      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([]) // today
        .mockResolvedValueOnce([]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 10, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 40, calories: 0, distanceKm: 0 } },
        ]); // month — the default period the preview ranks by

      const result = await getHierarchyOverview('g1');

      expect(Array.isArray(result.children)).toBe(true);
      expect(result.children).toHaveLength(1);
      expect(result.children[0].groupId).toBe('c1');
      expect(result.children[0].groupName).toBe('Child A');
      // Top-3 rows are MEMBERS (Alice/Bob), never the child group's own name.
      expect(result.children[0].top3.map((r) => r.name)).toEqual(['Bob', 'Alice']);
      expect(result.children[0].top3.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('re-ranks a section\'s Top-3 by that section\'s own period, independently of the others', async () => {
      mockPrisma.appGroup.findUnique.mockResolvedValueOnce({ id: 'g1', parentGroupId: null });
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([{ id: 'c1', name: 'Child A' }]);

      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'c1', userId: 'u1' },
        { groupId: 'c1', userId: 'u2' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([USER('u1', 'Alice'), USER('u2', 'Bob')]);

      // Bob leads on TODAY, Alice on week and month. Asking for
      // childrenPeriod='today' must therefore put Bob first — the preview now
      // picks the window out of the engine's member rows rather than issuing
      // its own query for it.
      mockPrisma.healthRecord.groupBy
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 5, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 50, calories: 0, distanceKm: 0 } },
        ]) // today
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 900, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 60, calories: 0, distanceKm: 0 } },
        ]) // week
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { steps: 900, calories: 0, distanceKm: 0 } },
          { userId: 'u2', _sum: { steps: 60, calories: 0, distanceKm: 0 } },
        ]); // month

      const result = await getHierarchyOverview('g1', { childrenPeriod: 'today' });

      expect(result.children[0].top3.map((r) => r.name)).toEqual(['Bob', 'Alice']);
    });

    it('returns an empty children array for a group with no child groups', async () => {
      mockPrisma.appGroup.findUnique.mockResolvedValueOnce({ id: 'g1', parentGroupId: null });
      mockPrisma.appGroup.findMany.mockResolvedValueOnce([]); // getChildGroups

      const result = await getHierarchyOverview('g1');

      expect(result.children).toEqual([]);
      expect(result.parent).toBeNull();
      expect(result.siblings).toEqual([]);
    });

    it('returns null for a group that does not exist', async () => {
      mockPrisma.appGroup.findUnique.mockResolvedValueOnce(null);
      const result = await getHierarchyOverview('missing-group');
      expect(result).toBeNull();
    });
  });

  describe('regression guard — row.points ?? row.totalPoints fallback (Phase 8 kept this alive)', () => {
    it('getGroupOwnOverview.overallStats.totalPoints falls back to totalPoints when .points is absent', async () => {
      // getGroupLeaderboard's all-time branch (no dates) never sets `.points`
      // — only `.totalPoints` (carried from the select) survives. This is
      // the exact shape sumOverallStats's `row.points ?? row.totalPoints`
      // fallback exists to handle; deleting the fallback would silently
      // zero out this figure.
      mockPrisma.groupMember.findMany
        .mockResolvedValueOnce([
          { user: USER('u1', 'Alice', 150) },
          { user: USER('u2', 'Bob', 250) },
        ]) // getGroupLeaderboard membership
        .mockResolvedValueOnce([
          { groupId: 'g1', userId: 'u1' },
          { groupId: 'g1', userId: 'u2' },
        ]); // getGroupPeriodStats membership
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]); // all-time steps + the 3 period windows

      const overview = await getGroupOwnOverview('g1', null, null);

      expect(overview.ranking.every((r) => r.points === undefined)).toBe(true);
      expect(overview.overallStats.totalPoints).toBe(400); // 150 + 250, via the totalPoints fallback
    });
  });
});
