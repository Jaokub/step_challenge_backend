-- HealthRecord: one row per user per day, regardless of source.
--
-- WHY
-- The unique key used to be [userId, recordDate, source], so a single day
-- could hold one row per source (e.g. a GOOGLE_HEALTH row AND a MANUAL row).
-- Consumers then disagreed about what that day's step count was:
--   * healthSync.aggregateByDate  -> SUM across rows  (dashboard / health screen)
--   * leaderboard.service         -> SUM across rows  (RANKING source of truth)
--   * activityAward.dailyMaxSteps -> MAX across rows  (ADR-001 award decisions)
-- So a user with two sources on one day was ranked on an inflated figure
-- while being paid points on a smaller one. Collapsing to one row per day
-- makes all three agree by construction instead of by convention.
--
-- DATA IMPACT
-- Users who genuinely had multiple sources on a day will see their totals for
-- those days DECREASE. That is the point: those totals were inflated. Nothing
-- is invented and nothing is summed — the surviving row keeps the highest
-- value each metric ever reached on that day from any source.

-- 1. Snapshot the per-metric maximum for every day that currently has more
--    than one row. Computed before the delete so no reading is lost.
CREATE TEMP TABLE hr_merged AS
SELECT
    "userId",
    "recordDate",
    MAX("steps")         AS "steps",
    MAX("calories")      AS "calories",
    MAX("distanceKm")    AS "distanceKm",
    MAX("activeMinutes") AS "activeMinutes"
FROM "public"."health_records"
GROUP BY "userId", "recordDate"
HAVING COUNT(*) > 1;

-- 2. Keep the most recently written row for each [user, day] and drop the
--    rest. Most-recent wins so the surviving row's `source` reflects the
--    device that last reported, matching the runtime last-writer-wins rule.
DELETE FROM "public"."health_records"
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT
            "id",
            ROW_NUMBER() OVER (
                PARTITION BY "userId", "recordDate"
                ORDER BY "createdAt" DESC, "id" DESC
            ) AS rn
        FROM "public"."health_records"
    ) ranked
    WHERE rn > 1
);

-- 3. Fold the snapshotted maxima into the surviving row.
UPDATE "public"."health_records" hr
SET "steps"         = m."steps",
    "calories"      = m."calories",
    "distanceKm"    = m."distanceKm",
    "activeMinutes" = m."activeMinutes"
FROM hr_merged m
WHERE hr."userId" = m."userId"
  AND hr."recordDate" = m."recordDate";

DROP TABLE hr_merged;

-- 4. Swap the constraint. Safe now that duplicates are gone.
DROP INDEX "public"."health_records_userId_recordDate_source_key";

CREATE UNIQUE INDEX "health_records_userId_recordDate_key"
    ON "public"."health_records"("userId" ASC, "recordDate" ASC);
