import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const { MAX_GROUP_DEPTH, getAncestorIds, resolveGroupAccess } = await import('./group.scope.js');

/** Wire appGroup.findUnique to look up parentGroupId from a plain id->parentId map. */
const wireTree = (parentById) => {
  mockPrisma.appGroup.findUnique.mockImplementation(({ where: { id } }) =>
    Promise.resolve(id in parentById ? { id, parentGroupId: parentById[id] } : null)
  );
};

describe('group.scope — hierarchy resolution (Phase 5.1 deferred tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAncestorIds', () => {
    it('walks a multi-level chain, nearest-parent first', async () => {
      // g1 (root) <- g2 <- g3 <- g4
      wireTree({ g1: null, g2: 'g1', g3: 'g2', g4: 'g3' });

      const ancestors = await getAncestorIds('g4');
      expect(ancestors).toEqual(['g3', 'g2', 'g1']);
    });

    it('returns an empty array for a root group', async () => {
      wireTree({ g1: null });
      expect(await getAncestorIds('g1')).toEqual([]);
    });

    it('has a cycle safety net — a malformed 2-node cycle terminates instead of looping forever', async () => {
      wireTree({ a: 'b', b: 'a' }); // invalid cycle, should never exist in practice
      const ancestors = await getAncestorIds('a');

      expect(ancestors.length).toBeLessThanOrEqual(MAX_GROUP_DEPTH + 2);
      // Termination proof: findUnique wasn't called an unbounded number of times.
      expect(mockPrisma.appGroup.findUnique.mock.calls.length).toBeLessThanOrEqual(MAX_GROUP_DEPTH + 2);
    });

    it('has a cycle safety net for a longer malformed cycle (a->b->c->a)', async () => {
      wireTree({ a: 'b', b: 'c', c: 'a' });
      const ancestors = await getAncestorIds('a');

      expect(mockPrisma.appGroup.findUnique.mock.calls.length).toBeLessThanOrEqual(MAX_GROUP_DEPTH + 2);
      expect(new Set(ancestors).size).toBe(ancestors.length); // no infinite duplication
    });
  });

  describe('resolveGroupAccess', () => {
    it('resolves "self" when the viewer is a member of the target group itself', async () => {
      wireTree({ g1: null });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1' }]);

      const { relation } = await resolveGroupAccess('viewer', 'g1');
      expect(relation).toBe('self');
    });

    it('grandparent-sees-grandchild resolves "ancestor" (not just immediate parent)', async () => {
      // g1 (root) <- g2 <- g3 (target). Viewer is a member of g1 only.
      wireTree({ g1: null, g2: 'g1', g3: 'g2' });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1' }]);

      const { relation } = await resolveGroupAccess('grandparent-coordinator', 'g3');
      expect(relation).toBe('ancestor');
    });

    it('resolves "ancestor" for the immediate parent too (still covered)', async () => {
      wireTree({ g1: null, g2: 'g1' });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g1' }]);

      const { relation } = await resolveGroupAccess('parent-coordinator', 'g2');
      expect(relation).toBe('ancestor');
    });

    it('non-adjacent, unrelated groups resolve to null', async () => {
      wireTree({ g1: null, g2: 'g1', g3: 'g2', g9: null });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g9' }]); // unrelated tree
      mockPrisma.groupMember.findFirst.mockResolvedValue(null); // not a sibling either

      const { relation } = await resolveGroupAccess('stranger', 'g3');
      expect(relation).toBeNull();
    });

    it('immediate-parent sibling still resolves "sibling"', async () => {
      // g1 (root) has two children: g2 (target) and g2b (viewer's group).
      wireTree({ g1: null, g2: 'g1', g2b: 'g1' });
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 'g2b' }]);
      mockPrisma.groupMember.findFirst.mockResolvedValue({ groupId: 'g2b' }); // sibling match

      const { relation } = await resolveGroupAccess('sibling-coordinator', 'g2');
      expect(relation).toBe('sibling');
    });

    it('returns null relation and null target for a nonexistent target group', async () => {
      wireTree({}); // findUnique resolves null for anything
      const result = await resolveGroupAccess('anyone', 'ghost-group');
      expect(result).toEqual({ relation: null, target: null });
    });
  });
});
