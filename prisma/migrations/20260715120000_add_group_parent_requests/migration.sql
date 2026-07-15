-- CreateEnum
CREATE TYPE "GroupParentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "group_parent_requests" (
    "id" TEXT NOT NULL,
    "childGroupId" TEXT NOT NULL,
    "parentGroupId" TEXT NOT NULL,
    "status" "GroupParentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "group_parent_requests_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "group_parent_requests" ADD CONSTRAINT "group_parent_requests_childGroupId_fkey" FOREIGN KEY ("childGroupId") REFERENCES "app_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_parent_requests" ADD CONSTRAINT "group_parent_requests_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "app_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_parent_requests" ADD CONSTRAINT "group_parent_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
