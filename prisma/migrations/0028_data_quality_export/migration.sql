-- Data Quality filtered export. Additive only: two nullable columns (files uploaded before this
-- keep NULL there) and one new audit table. No existing row or column is changed.

-- AlterTable
ALTER TABLE `data_quality_jobs` ADD COLUMN `headers` JSON NULL;

-- AlterTable
ALTER TABLE `data_quality_records` ADD COLUMN `raw` JSON NULL;

-- CreateTable
CREATE TABLE `data_quality_export_logs` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `filename` VARCHAR(200) NOT NULL,
    `byEmail` VARCHAR(191) NULL,
    `format` VARCHAR(8) NOT NULL,
    `filters` JSON NOT NULL,
    `columns` JSON NOT NULL,
    `includeExcluded` BOOLEAN NOT NULL DEFAULT false,
    `rowCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `data_quality_export_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
