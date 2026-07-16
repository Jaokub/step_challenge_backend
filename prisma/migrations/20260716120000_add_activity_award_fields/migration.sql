-- Step-gated activity points (ADR-001, BUILD_PLAN.md Phase 7 PR 1).
-- Additive columns on check_ins:
--   stepsAtCheckIn  = baseline snapshot of the user's known cumulative steps
--                     on the check-in day (D4). NULL for attendance-only
--                     check-ins and for legacy rows predating this feature.
--   pointsAwardedAt = set once activity.points has actually been paid for
--                     this check-in. NULL = not yet (step-gated, goal not
--                     reached). Drives award idempotency + correct cancellation.

-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN "stepsAtCheckIn" INTEGER;
ALTER TABLE "check_ins" ADD COLUMN "pointsAwardedAt" TIMESTAMP(3);

-- Data backfill (forward-only, per ADR-001): every pre-existing check-in was
-- already paid under the old immediate-on-check-in rule, so mark it as
-- awarded (dated to its check-in) — otherwise the next health sync could
-- double-award it, or a cancellation would refuse to reverse points that
-- were in fact granted. stepsAtCheckIn stays NULL on these legacy rows by
-- design: it is never read once pointsAwardedAt is set.
UPDATE "check_ins" SET "pointsAwardedAt" = "checkedInAt" WHERE "pointsAwardedAt" IS NULL;
