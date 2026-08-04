import prisma from '../config/prisma.js';
import { getSubtreeGroups } from './group.scope.js';
import { thaiDayTag, thaiWeekStartTag, thaiMonthStartTag, addDays } from '../utils/thaiTime.js';

/**
 * @module GroupAggregationService
 * @description The batched engine behind every group step figure (ADR-003).
 *
 * A group's numbers cover its WHOLE SUBTREE, not just the members attached to
 * it directly. Before ADR-003 a parent group whose people had all joined its
 * child groups reported zero steps and an empty ranking, which is the state
 * `PERMISSION_REVIEW.md` A3 describes.
 *
 * Split out of groupOverview.service.js to keep both files near the 200-line
 * convention, and because this is genuinely a separate job: resolving *who
 * counts for a group* is independent of how the overview screens present it.
 *
 * ── Two invariants worth stating up front ──
 *
 * 1. **Fixed query count.** `depth + 5` regardless of how many groups or
 *    members are involved: the tree walk (bounded by MAX_GROUP_DEPTH), one
 *    membership query, one user query, three window aggregations. The
 *    group-detail screen asks for self + parent + siblings + children at once,
 *    so anything per-group here multiplies immediately.
 *
 * 2. **A person counts once per group.** Membership is accumulated into a Set,
 *    so someone in two child groups contributes to their parent's total once —
 *    while still counting fully toward each child's own total. This makes a
 *    parent's total SMALLER than the sum of its children, deliberately; see
 *    ADR-003 decision 2.
 */

const EMPTY_PERIOD = () => ({ steps: 0, calories: 0, distanceKm: 0 });

/**
 * The three windows the relation cards display, as HealthRecord.recordDate
 * bounds. `recordDate` is a @db.Date UTC-midnight tag, so these use the
 * thaiTime "tag" helpers. All three run from the period start up to and
 * including today.
 * @param {Date} [now]
 */
export const periodWindows = (now = new Date()) => {
  const dayStart = thaiDayTag(now);
  const tomorrow = addDays(dayStart, 1); // exclusive upper bound = end of today
  return {
    today: { gte: dayStart, lt: tomorrow },
    week: { gte: thaiWeekStartTag(now), lt: tomorrow },
    month: { gte: thaiMonthStartTag(now), lt: tomorrow },
  };
};

const PERIODS = ['today', 'week', 'month'];

/** Per-root accumulator used while folding; never returned as-is. */
const newAccumulator = () => ({
  memberIds: new Set(),
  directMemberIds: new Set(),
  badgeGroupsByUser: new Map(),
});

const emptyGroupStats = () => ({
  today: EMPTY_PERIOD(),
  week: EMPTY_PERIOD(),
  month: EMPTY_PERIOD(),
  subtreeMemberCount: 0,
  members: [],
  directOnly: { today: EMPTY_PERIOD(), week: EMPTY_PERIOD(), month: EMPTY_PERIOD(), count: 0 },
});

/**
 * Subtree step totals, member rows and sub-group badges for a set of groups.
 *
 * @param {string[]} groupIds - roots to aggregate. Duplicates ignored.
 * @returns {Promise<Map<string, {
 *   today: {steps:number,calories:number,distanceKm:number},
 *   week: object, month: object,
 *   subtreeMemberCount: number,
 *   members: Array<{userId:string, fullName:string, avatarUrl:string|null,
 *                   groups:Array<{id:string,name:string}>,
 *                   today:object, week:object, month:object}>,
 *   directOnly: {today:object, week:object, month:object, count:number}
 * }>>}
 *
 * `subtreeMemberCount` is named that way on purpose — `AppGroup._count.members`
 * counts DIRECT members and is what every "{{count}} คน" label renders today.
 * Showing this one through the same label would report the same group as both
 * "500" and "3". See ADR-003.
 */
export const getGroupsPeriodSteps = async (groupIds) => {
  const roots = [...new Set(groupIds)];
  const result = new Map(roots.map((id) => [id, emptyGroupStats()]));
  if (roots.length === 0) return result;

  // ── 1. Expand every root's subtree in one walk ──────────────────────────
  const subtrees = await getSubtreeGroups(roots);

  /** groupId -> the roots it contributes to (a group can serve several). */
  const rootsByGroup = new Map();
  const attribute = (groupId, rootId) => {
    if (!rootsByGroup.has(groupId)) rootsByGroup.set(groupId, new Set());
    rootsByGroup.get(groupId).add(rootId);
  };

  const groupNames = new Map();
  for (const rootId of roots) {
    attribute(rootId, rootId); // a root counts toward itself
    for (const descendant of subtrees.get(rootId) ?? []) {
      attribute(descendant.id, rootId);
      groupNames.set(descendant.id, descendant.name);
    }
  }

  // ── 2. Memberships for every group involved, in one query ───────────────
  const memberships = await prisma.groupMember.findMany({
    where: { groupId: { in: [...rootsByGroup.keys()] } },
    select: { groupId: true, userId: true },
  });

  const acc = new Map(roots.map((id) => [id, newAccumulator()]));
  for (const { groupId, userId } of memberships) {
    for (const rootId of rootsByGroup.get(groupId) ?? []) {
      const a = acc.get(rootId);
      a.memberIds.add(userId); // Set => dedupe, see invariant 2
      if (groupId === rootId) {
        a.directMemberIds.add(userId);
      } else {
        // Membership of a DESCENDANT is what earns a badge. The viewed group
        // itself is never a badge — that is what makes a leaf group's rows
        // come back with `groups: []` and the UI hide the column with no
        // "does this group have children?" flag anywhere.
        if (!a.badgeGroupsByUser.has(userId)) a.badgeGroupsByUser.set(userId, []);
        a.badgeGroupsByUser.get(userId).push({ id: groupId, name: groupNames.get(groupId) ?? '' });
      }
    }
  }

  const allUserIds = [...new Set(memberships.map((m) => m.userId))];
  if (allUserIds.length === 0) return result;

  // ── 3 + 4. User names and the three window aggregations ─────────────────
  const w = periodWindows();
  const [users, todayRows, weekRows, monthRows] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, fullName: true, avatarUrl: true },
    }),
    ...PERIODS.map((period) =>
      prisma.healthRecord.groupBy({
        by: ['userId'],
        where: { userId: { in: allUserIds }, recordDate: w[period] },
        _sum: { steps: true, calories: true, distanceKm: true },
      })
    ),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const toMap = (rows) => new Map(rows.map((r) => [r.userId, r._sum]));
  const sums = { today: toMap(todayRows), week: toMap(weekRows), month: toMap(monthRows) };

  const stepsFor = (userId, period) => {
    const s = sums[period].get(userId);
    return {
      steps: s?.steps ?? 0,
      calories: s?.calories ?? 0,
      distanceKm: s?.distanceKm ?? 0,
    };
  };

  const addInto = (target, source) => {
    target.steps += source.steps;
    target.calories += source.calories;
    target.distanceKm += source.distanceKm;
  };

  // ── 5. Fold per-user sums into each root ────────────────────────────────
  for (const rootId of roots) {
    const a = acc.get(rootId);
    const out = result.get(rootId);
    out.subtreeMemberCount = a.memberIds.size;

    for (const userId of a.memberIds) {
      const user = userById.get(userId);
      const perPeriod = {
        today: stepsFor(userId, 'today'),
        week: stepsFor(userId, 'week'),
        month: stepsFor(userId, 'month'),
      };

      // Badges sorted by plain string comparison, NOT localeCompare — that
      // depends on the runtime's ICU data and would make ordering (and the
      // tests) environment-dependent. Which order is cosmetic; determinism
      // is not.
      const groups = (a.badgeGroupsByUser.get(userId) ?? [])
        .slice()
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

      out.members.push({
        userId,
        fullName: user?.fullName ?? '',
        avatarUrl: user?.avatarUrl ?? null,
        groups,
        ...perPeriod,
      });

      for (const period of PERIODS) addInto(out[period], perPeriod[period]);

      // "Direct only" = in this group and in NONE of its descendants. Not the
      // same as a direct member: someone in both the parent and a child
      // belongs to the child's row, or the children breakdown would show the
      // same person twice. See ADR-003 decision 4.
      if (a.directMemberIds.has(userId) && groups.length === 0) {
        out.directOnly.count += 1;
        for (const period of PERIODS) addInto(out.directOnly[period], perPeriod[period]);
      }
    }
  }

  return result;
};

/**
 * Single-group convenience wrapper.
 * @param {string} groupId
 */
export const getGroupPeriodStats = async (groupId) => {
  const map = await getGroupsPeriodSteps([groupId]);
  return map.get(groupId);
};

export default { getGroupsPeriodSteps, getGroupPeriodStats, periodWindows };
