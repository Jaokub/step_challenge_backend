/*
  Warnings:

  - A unique constraint covering the columns `[googleId]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "app_groups" ADD COLUMN     "parentGroupId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "googleId" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL,
ALTER COLUMN "department" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- AddForeignKey
ALTER TABLE "app_groups" ADD CONSTRAINT "app_groups_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "app_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
