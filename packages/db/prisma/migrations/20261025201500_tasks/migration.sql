-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateTable
CREATE TABLE "tasks" (
    "id" VARCHAR(36) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMPTZ(3),
    "origin" VARCHAR(12) NOT NULL,
    "creationHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_sources" (
    "taskId" VARCHAR(36) NOT NULL,
    "noteId" VARCHAR(36) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "captureId" VARCHAR(36) NOT NULL,
    "evidence" TEXT,

    CONSTRAINT "task_sources_pkey" PRIMARY KEY ("taskId","noteId")
);

-- CreateTable
CREATE TABLE "task_events" (
    "taskId" VARCHAR(36) NOT NULL,
    "ownerSubject" VARCHAR(128) NOT NULL,
    "revision" INTEGER NOT NULL,
    "type" VARCHAR(24) NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("taskId","revision")
);

-- CreateTable
CREATE TABLE "task_commands" (
    "ownerSubject" VARCHAR(128) NOT NULL,
    "id" VARCHAR(36) NOT NULL,
    "taskId" VARCHAR(36) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,

    CONSTRAINT "task_commands_pkey" PRIMARY KEY ("ownerSubject","id")
);

-- CreateIndex
CREATE INDEX "tasks_ownerSubject_status_createdAt_id_idx" ON "tasks"("ownerSubject", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_id_ownerSubject_key" ON "tasks"("id", "ownerSubject");

-- CreateIndex
CREATE INDEX "task_sources_ownerSubject_noteId_idx" ON "task_sources"("ownerSubject", "noteId");

-- CreateIndex
CREATE UNIQUE INDEX "notes_id_ownerSubject_captureId_key" ON "notes"("id", "ownerSubject", "captureId");

-- AddForeignKey
ALTER TABLE "task_sources" ADD CONSTRAINT "task_sources_taskId_ownerSubject_fkey" FOREIGN KEY ("taskId", "ownerSubject") REFERENCES "tasks"("id", "ownerSubject") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "task_sources" ADD CONSTRAINT "task_sources_noteId_ownerSubject_captureId_fkey" FOREIGN KEY ("noteId", "ownerSubject", "captureId") REFERENCES "notes"("id", "ownerSubject", "captureId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_taskId_ownerSubject_fkey" FOREIGN KEY ("taskId", "ownerSubject") REFERENCES "tasks"("id", "ownerSubject") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "task_commands" ADD CONSTRAINT "task_commands_taskId_ownerSubject_fkey" FOREIGN KEY ("taskId", "ownerSubject") REFERENCES "tasks"("id", "ownerSubject") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- State, text bounds and immutable source capture identity have SQL defenses too.
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (
  revision > 0 AND ((status = 'OPEN' AND "completedAt" IS NULL) OR
  (status = 'COMPLETED' AND "completedAt" IS NOT NULL))
);
ALTER TABLE tasks ADD CONSTRAINT tasks_text_check CHECK (
  length(btrim(title)) > 0 AND length(description) <= 8000 AND origin IN ('api','github')
);
ALTER TABLE task_sources ADD CONSTRAINT task_sources_evidence_check CHECK (length(evidence) BETWEEN 1 AND 2000);
ALTER TABLE task_events ADD CONSTRAINT task_events_transition_check CHECK (
  revision > 0 AND ((type = 'CREATED' AND revision = 1 AND status = 'OPEN') OR
  (type = 'COMPLETED' AND revision > 1 AND status = 'COMPLETED') OR
  (type = 'REOPENED' AND revision > 1 AND status = 'OPEN'))
);
