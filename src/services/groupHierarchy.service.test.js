import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

// group.scope's getAncestorIds is mocked directly so wouldCreateCycle /
// depthWouldExceed tests can control "how deep is the proposed parent"
// without also having to fake the exact upward-walk prisma calls —
// getAncestorIds itself is already covered by group.scope.test.js.
const getAncestorIds = vi.fn();
vi.mock('./group.scope.js', () => ({
  MAX_GROUP_DEPTH: 3,
  getAncestorIds: (...args) => getAncestorIds(...args),
}));

const { wouldCreateCycle, depthWouldExceed, getDescendantIds, getSubtreeHeight } = await import(
  './groupHierarchy.service.js'
);

/** Wire appGroup.findMany's parentGroupId-in-frontier BFS from a children map. */
const wireChildren = (childrenByParentId) => {
  mockPrisma.appGroup.findMany.mockImplementation(({ where: { parentGroupId } }) => {
    const frontier = parentGroupId.in;
    const ids = frontier.flatMap((pid) => childrenByParentId[pid] ?? []);
    return Promise.resolve(ids.map((id) => ({ id })));
  });
};

describe('groupHierarchy.service — multi-level tree guards (Phase 5.1 deferred tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAncestorIds.mockReset();
  });

  describe('getDescendantIds', () => {
    it('collects a multi-level subtree breadth-first', async () => {
      // A -> [B, C], B -> [D]
      wireChildren({ A: ['B', 'C'], B: ['D'] });
      const descendants = await getDescendantIds('A');
      expect(new Set(descendants)).toEqual(new Set(['B', 'C', 'D']));
    });

    it('returns an empty array for a leaf group', async () => {
      wireChildren({});
      expect(await getDescendantIds('leaf')).toEqual([]);
    });
  });

  describe('getSubtreeHeight', () => {
    it('is 0 for a leaf (no children)', async () => {
      wireChildren({});
      expect(await getSubtreeHeight('leaf')).toBe(0);
    });

    it('is 1 for a group with only childless children', async () => {
      wireChildren({ A: ['B'] });
      expect(await getSubtreeHeight('A')).toBe(1);
    });

    it('is 2 for a two-level-deep subtree', async () => {
      wireChildren({ A: ['B'], B: ['C'] });
      expect(await getSubtreeHeight('A')).toBe(2);
    });
  });

  describe('wouldCreateCycle', () => {
    it('direct A -> A (self-parent) is always a cycle', async () => {
      expect(await wouldCreateCycle('a', 'a')).toBe(true);
      // Short-circuits before touching the DB at all.
      expect(getAncestorIds).not.toHaveBeenCalled();
    });

    it('indirect A -> B -> C -> A: proposing A as a child of C is a cycle (C is A\'s descendant)', async () => {
      // Existing tree: A -> B -> C. Proposing childId=A under proposedParentId=C.
      getAncestorIds.mockResolvedValue(['B', 'A']); // ancestors of C
      wireChildren({}); // descendant check won't even be reached (ancestor check catches it first)

      expect(await wouldCreateCycle('A', 'C')).toBe(true);
    });

    it('proposed-parent-is-a-descendant-of-child is caught even when the ancestor walk misses it', async () => {
      // Simulates a case the ancestor-chain walk (bounded, or racing a
      // concurrent edit) doesn't catch, to prove the independent
      // descendant-of-child check is a real second line of defense, not
      // dead code shadowed by the first check.
      getAncestorIds.mockResolvedValue([]); // ancestor walk reports nothing
      wireChildren({ child: ['mid'], mid: ['proposedParent'] }); // proposedParent is 2 levels under child

      expect(await wouldCreateCycle('child', 'proposedParent')).toBe(true);
    });

    it('unrelated groups do not create a cycle', async () => {
      getAncestorIds.mockResolvedValue(['someOtherRoot']);
      wireChildren({ child: ['unrelatedLeaf'] });

      expect(await wouldCreateCycle('child', 'proposedParent')).toBe(false);
    });
  });

  describe('depthWouldExceed (MAX_GROUP_DEPTH = 3)', () => {
    it('root parent + leaf child is allowed (deepest level 2)', async () => {
      getAncestorIds.mockResolvedValue([]); // proposedParent is a root -> level 1
      wireChildren({}); // child is a leaf -> height 0

      expect(await depthWouldExceed('leafChild', 'rootParent')).toBe(false);
    });

    it('a level-MAX (3) parent gaining any child is rejected', async () => {
      getAncestorIds.mockResolvedValue(['grandparent', 'root']); // proposedParent at level 3
      wireChildren({}); // child is a leaf -> height 0

      expect(await depthWouldExceed('leafChild', 'level3Parent')).toBe(true);
    });

    it('a mid-tree (level 2) parent gaining a child with its own subtree is rejected at the boundary', async () => {
      getAncestorIds.mockResolvedValue(['root']); // proposedParent at level 2
      wireChildren({ childWithSubtree: ['grandchild'] }); // child height = 1

      // deepestLevel = 2 (parentLevel) + 1 + 1 (childHeight) = 4 > 3
      expect(await depthWouldExceed('childWithSubtree', 'level2Parent')).toBe(true);
    });

    it('a mid-tree (level 2) parent gaining a childless child is exactly at the boundary — allowed', async () => {
      getAncestorIds.mockResolvedValue(['root']); // proposedParent at level 2
      wireChildren({}); // child is a leaf -> height 0

      // deepestLevel = 2 + 1 + 0 = 3, not > 3
      expect(await depthWouldExceed('leafChild', 'level2Parent')).toBe(false);
    });
  });
});
