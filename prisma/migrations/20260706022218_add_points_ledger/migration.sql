-- CreateEnum
CREATE TYPE "PointsReason" AS ENUM ('HEALTH_SYNC', 'ACTIVITY_CHECKIN', 'CHECKIN_CANCELLED', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "points_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" "PointsReason" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "points_ledger_userId_effectiveDate_idx" ON "points_ledger"("userId", "effectiveDate");

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
