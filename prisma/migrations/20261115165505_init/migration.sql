-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "Repeat" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "dueDate" DATE,
    "dueTime" TEXT,
    "repeat" "Repeat",
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMPTZ,
    "categoryId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtask" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCompletion" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "completedOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");

-- CreateIndex
CREATE INDEX "Task_userId_done_idx" ON "Task"("userId", "done");

-- CreateIndex
CREATE INDEX "Task_userId_dueDate_idx" ON "Task"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "Subtask_taskId_position_idx" ON "Subtask"("taskId", "position");

-- CreateIndex
CREATE INDEX "TaskCompletion_taskId_completedOn_idx" ON "TaskCompletion"("taskId", "completedOn");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCompletion" ADD CONSTRAINT "TaskCompletion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Security: lock these tables away from Supabase's public web API.
-- Supabase exposes the "public" schema over its Data API, and the publishable
-- key that reaches it is public by design. Enabling row level security with
-- no policies denies every request through that API. The app itself connects
-- through Prisma as the table owner, which RLS doesn't restrict, and filters
-- every query by the signed-in user's id.
ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subtask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskCompletion" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON "Category", "Task", "Subtask", "TaskCompletion" FROM anon, authenticated;
