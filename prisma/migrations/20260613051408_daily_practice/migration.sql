-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "challengeCompletedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastStreakDate" TEXT,
ADD COLUMN     "streakCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "weeklyActiveDates" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "weeklyResetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PracticeSession" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "theme" TEXT NOT NULL,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "highlights" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PracticeSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeSession_chatId_idx" ON "PracticeSession"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeSession_chatId_date_key" ON "PracticeSession"("chatId", "date");

-- AddForeignKey
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
