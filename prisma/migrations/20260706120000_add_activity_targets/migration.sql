-- AlterTable: add optional step / distance targets to activities
ALTER TABLE "activities" ADD COLUMN "expectedSteps" INTEGER;
ALTER TABLE "activities" ADD COLUMN "totalDistance" DOUBLE PRECISION;
