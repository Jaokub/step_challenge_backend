import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const leaderboardModule = await import('./leaderboard.service.js');
const { getFriendsLeaderboard, getGroupLeaderboard } = leaderboardModule;

const USER = (id, name, totalPoints = 0) => ({
  id,
  fullName: name,
  avatarUrl: null,
  department: 'ENG',
  totalPoints,
});

describe('leaderboard.service — step-based ranking (BUILD_PLAN Phase 6A HIGH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: healthy no-op for the points ledger groupBy so tests that
    // don't care about it (all-time branch) don't need to stub it.
    mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);
    // ADR-003: getGroupLeaderboard now resolves the group's subtree first.
    // Empty = "this group is a leaf", which is what most of these assume.
    mockPrisma.appGroup.findMany.mockResolvedValue([]);
  });

  /** Wire the downward subtree walk: `{ parentId: [childId, ...] }`. */
  const wireSubtree = (childrenByParentId) => {
    mockPrisma.appGroup.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        (where?.parentGroupId?.in ?? []).flatMap((pid) =>
          (childrenByParentId[pid] ?? []).map((id) => ({ id, name: `name-${id}`, parentGroupId: pid }))
        )
      )
    );
  };

  describe('every leaderboard is scoped — there is no global one (F2, removed 2026-08-03)', () => {
    // `getGlobalLeaderboard` and its six specs were deleted here along with
    // the function. What replaces them is one assertion about the module's
    // shape, which is the durable property: ranking is something you have
    // *relative to* a friend graph or a group, never relative to the whole
    // faculty. A flat all-staff ranking has no place in the hierarchy model,
    // which is why `app/leaderboard.tsx` went on 2026-07-20 and the endpoint
    // followed on 2026-08-03.
    //
    // This fails the moment someone re-exports an unscoped leaderboard, which
    // is cheaper to notice here than in review.
    it('exports no unscoped leaderboard function', async () => {
      const exported = Object.keys(leaderboardModule).filter((k) => k !== 'default');

      expect(exported).not.toContain('getGlobalLeaderboard');
      expect(exported.filter((k) => k.startsWith('get'))).toEqual([
        'getFriendsLeaderboard',
        'getGroupLeaderboard',
      ]);
    });

    it('keeps the default export in step with the named ones', async () => {
      // The controller imports the default object, so a stale key here would
      // resurrect the function through the back door.
      expect(Object.keys(leaderboardModule.default).sort()).toEqual([
        'getFriendsLeaderboard',
        'getGroupLeaderboard',
      ]);
    });
  });

  describe('getFriendsLeaderboard', () => {
    it('includes the signed-in user even with zero friendships', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([{ userId: 'me', _sum: { steps: 42 } }]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result).toHaveLength(1);
      expect(result[0].fullName).toBe('Me');
      expect(result[0].rank).toBe(1);
    });

    it('ranks by steps (not points) in the all-time branch', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend', 99999) },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 100 } },
        { userId: 'f1', _sum: { steps: 5000 } }, // way more steps, far fewer "points"
      ]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result.map((r) => r.fullName)).toEqual(['Friend', 'Me']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('ranks by steps in the date-window branch too (points ledger present but unused for ranking)', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 10, calories: 1, distanceKm: 1 } },
        { userId: 'f1', _sum: { steps: 20, calories: 1, distanceKm: 1 } },
      ]);
      // Deliberately give 'me' more points than 'f1' to prove points don't drive order.
      mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { amount: 500 } },
        { userId: 'f1', _sum: { amount: 1 } },
      ]);

      const result = await getFriendsLeaderboard('me', '2026-07-01', '2026-07-08');
      expect(result.map((r) => r.fullName)).toEqual(['Friend', 'Me']);
    });

    it('de-duplicates a bidirectional friendship pair into one entry', async () => {
      // Friendship rows can appear with the current user on either side.
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'Friend') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const result = await getFriendsLeaderboard('me', null, null);
      const ids = result.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
    });

    it('produces contiguous 1..N rank numbering', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([
        { userId: 'me', friendId: 'f1', user: USER('me', 'Me'), friend: USER('f1', 'A') },
        { userId: 'me', friendId: 'f2', user: USER('me', 'Me'), friend: USER('f2', 'B') },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue(USER('me', 'Me'));
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'me', _sum: { steps: 300 } },
        { userId: 'f1', _sum: { steps: 100 } },
        { userId: 'f2', _sum: { steps: 200 } },
      ]);

      const result = await getFriendsLeaderboard('me', null, null);
      expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(result.map((r) => r.fullName)).toEqual(['Me', 'B', 'A']);
    });
  });

  describe('getGroupLeaderboard', () => {
    it('ranks group members by steps descending with 1..N ranks (all-time branch)', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'Low') },
        { user: USER('u2', 'High') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 50 } },
        { userId: 'u2', _sum: { steps: 500 } },
      ]);

      const result = await getGroupLeaderboard('g1', null, null);
      expect(result.map((r) => r.fullName)).toEqual(['High', 'Low']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('ranks by steps in the date-window branch', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'Low') },
        { user: USER('u2', 'High') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 50, calories: 1, distanceKm: 1 } },
        { userId: 'u2', _sum: { steps: 500, calories: 1, distanceKm: 1 } },
      ]);
      mockPrisma.pointsLedgerEntry.groupBy.mockResolvedValue([]);

      const result = await getGroupLeaderboard('g1', '2026-07-01', '2026-07-08');
      expect(result.map((r) => r.fullName)).toEqual(['High', 'Low']);
    });

    it('an empty group returns an empty array', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([]);
      const result = await getGroupLeaderboard('empty-group', null, null);
      expect(result).toEqual([]);
    });
  });

  describe('getGroupLeaderboard — subtree coverage (ADR-003)', () => {
    it('ranks people from child groups, not just direct members', async () => {
      // The A3 bug exactly: nobody joined `parent` directly, so it used to
      // return an empty ranking however far its departments had walked.
      wireSubtree({ parent: ['childA', 'childB'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'childA', user: USER('u1', 'Low') },
        { groupId: 'childB', user: USER('u2', 'High') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([
        { userId: 'u1', _sum: { steps: 50 } },
        { userId: 'u2', _sum: { steps: 500 } },
      ]);

      const result = await getGroupLeaderboard('parent', null, null);

      expect(result.map((r) => r.fullName)).toEqual(['High', 'Low']);
      expect(result.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('lists a person once even when they are in several sub-groups', async () => {
      wireSubtree({ parent: ['childA', 'childB'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'childA', user: USER('shared', 'Shared') },
        { groupId: 'childB', user: USER('shared', 'Shared') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([{ userId: 'shared', _sum: { steps: 100 } }]);

      const result = await getGroupLeaderboard('parent', null, null);

      expect(result).toHaveLength(1);
      expect(result[0].steps).toBe(100); // not doubled
    });

    it('attaches the sub-groups each person belongs to, sorted by name', async () => {
      wireSubtree({ parent: ['zebra', 'alpha'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'zebra', user: USER('u1', 'A') },
        { groupId: 'alpha', user: USER('u1', 'A') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const [row] = await getGroupLeaderboard('parent', null, null);

      expect(row.groups).toEqual([
        { id: 'alpha', name: 'name-alpha' },
        { id: 'zebra', name: 'name-zebra' },
      ]);
    });

    it('never lists the viewed group itself as a badge', async () => {
      // What makes a leaf group's rows come back with `groups: []`, so the
      // client can hide the column without knowing the tree shape.
      wireSubtree({ parent: ['child'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'parent', user: USER('u1', 'A') },
        { groupId: 'child', user: USER('u1', 'A') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const [row] = await getGroupLeaderboard('parent', null, null);
      expect(row.groups.map((g) => g.id)).toEqual(['child']);
    });

    it('gives every row an empty badge list on a leaf group', async () => {
      wireSubtree({});
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'leaf', user: USER('u1', 'A') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const [row] = await getGroupLeaderboard('leaf', null, null);
      expect(row.groups).toEqual([]);
    });

    it('resolves the subtree once, not per member', async () => {
      wireSubtree({ parent: ['c1'] });
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { groupId: 'c1', user: USER('u1', 'A') },
        { groupId: 'c1', user: USER('u2', 'B') },
        { groupId: 'c1', user: USER('u3', 'C') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getGroupLeaderboard('parent', null, null);

      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(1);
    });

    it('⚠️ returns every member with no pagination — a known limit', async () => {
      // Recorded rather than fixed (ADR-003 "Out of scope"). A subtree of 500
      // people is roughly 75 KB per response, fine at current scale. If a
      // group ever spans thousands this needs revisiting; the assertion is
      // here so the limit is a decision, not a surprise.
      wireSubtree({});
      const many = Array.from({ length: 250 }, (_, i) => ({
        groupId: 'leaf',
        user: USER(`u${i}`, `User ${i}`),
      }));
      mockPrisma.groupMember.findMany.mockResolvedValue(many);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      const result = await getGroupLeaderboard('leaf', null, null);

      expect(result).toHaveLength(250);
      expect(mockPrisma.groupMember.findMany.mock.calls[0][0].take).toBeUndefined();
    });
  });

  describe('applyAllTimeSteps (exercised via the all-time branches above)', () => {
    it('issues exactly one healthRecord.groupBy call regardless of member count', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([
        { user: USER('u1', 'A') },
        { user: USER('u2', 'B') },
        { user: USER('u3', 'C') },
        { user: USER('u4', 'D') },
      ]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]);

      await getGroupLeaderboard('g1', null, null);
      expect(mockPrisma.healthRecord.groupBy).toHaveBeenCalledTimes(1);
    });

    it('zero-fills users with no HealthRecord rows instead of leaving steps undefined', async () => {
      mockPrisma.groupMember.findMany.mockResolvedValue([{ user: USER('u1', 'NoRecords') }]);
      mockPrisma.healthRecord.groupBy.mockResolvedValue([]); // nothing for u1

      const result = await getGroupLeaderboard('g1', null, null);
      expect(result[0].steps).toBe(0);
      expect(result[0].calories).toBe(0);
      expect(result[0].distance).toBe(0);
    });

    it('skips the query entirely for an empty user list', async () => {
      mockPrisma.friendship.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue(null); // current user not found either
      mockPrisma.healthRecord.groupBy.mockClear();

      await getFriendsLeaderboard('nonexistent', null, null);
      expect(mockPrisma.healthRecord.groupBy).not.toHaveBeenCalled();
    });
  });
});
