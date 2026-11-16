-- AlterTable
ALTER TABLE "TaskCompletion" ADD COLUMN     "previousDueDate" DATE,
ADD COLUMN     "stepsDone" UUID[] DEFAULT ARRAY[]::UUID[];
