-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "dailyPracticeCompletedAt" TIMESTAMP(3),
ADD COLUMN     "dailyPracticeResetAt" TIMESTAMP(3),
ADD COLUMN     "dailyPracticeSentenceCount" INTEGER NOT NULL DEFAULT 0;
