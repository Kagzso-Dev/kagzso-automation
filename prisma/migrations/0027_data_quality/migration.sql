-- CreateTable
CREATE TABLE `data_quality_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `filename` VARCHAR(200) NOT NULL,
    `status` ENUM('RUNNING', 'PAUSED', 'CANCELLED', 'DONE') NOT NULL DEFAULT 'RUNNING',
    `mapping` JSON NOT NULL,
    `total` INTEGER NOT NULL DEFAULT 0,
    `valid` INTEGER NOT NULL DEFAULT 0,
    `invalid` INTEGER NOT NULL DEFAULT 0,
    `duplicates` INTEGER NOT NULL DEFAULT 0,
    `excluded` INTEGER NOT NULL DEFAULT 0,
    `aiStatus` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `aiModel` VARCHAR(100) NULL,
    `aiDone` INTEGER NOT NULL DEFAULT 0,
    `aiFailures` INTEGER NOT NULL DEFAULT 0,
    `note` VARCHAR(300) NULL,
    `waitingReason` VARCHAR(200) NULL,
    `runToken` VARCHAR(40) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `data_quality_jobs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `data_quality_records` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `rowIndex` INTEGER NOT NULL,
    `name` VARCHAR(160) NULL,
    `phoneRaw` VARCHAR(64) NULL,
    `phone` VARCHAR(20) NULL,
    `businessName` VARCHAR(200) NULL,
    `email` VARCHAR(191) NULL,
    `status` ENUM('VALID', 'INVALID', 'DUPLICATE', 'EXCLUDED') NOT NULL,
    `excludedReason` VARCHAR(32) NULL,
    `issues` JSON NOT NULL,
    `flags` JSON NOT NULL,
    `ruleScore` INTEGER NULL,
    `aiState` VARCHAR(16) NOT NULL DEFAULT 'NONE',
    `aiScore` INTEGER NULL,
    `aiNotes` VARCHAR(500) NULL,
    `review` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `data_quality_records_jobId_status_idx`(`jobId`, `status`),
    INDEX `data_quality_records_jobId_aiState_idx`(`jobId`, `aiState`),
    UNIQUE INDEX `data_quality_records_jobId_rowIndex_key`(`jobId`, `rowIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `data_quality_records` ADD CONSTRAINT `data_quality_records_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `data_quality_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

