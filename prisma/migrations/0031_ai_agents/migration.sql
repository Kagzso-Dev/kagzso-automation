-- AI Agents (Calls → each language → "AI Agents"; packages/shared/src/aiAgents.ts).
-- Additive only: five new tables. No existing table or row changes (call_flows only gets incoming
-- foreign keys from ai_agents; deleting a flow sets the agent's link to NULL).
--   ai_business_categories / ai_industries   one shared library for every language (seeded below)
--   ai_agents                                 one per business and language; contactGender male | female | unspecified
--   ai_agent_knowledge_files / _items         uploaded knowledge, each item Draft until an admin approves it
-- Undo: down.sql (drops the five tables).

-- CreateTable
CREATE TABLE `ai_business_categories` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_business_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_industries` (
    `id` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `discoveryTopics` TEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_industries_categoryId_name_key`(`categoryId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agents` (
    `id` VARCHAR(191) NOT NULL,
    `language` VARCHAR(8) NOT NULL,
    `mode` ENUM('GUIDED', 'AUTONOMOUS') NOT NULL DEFAULT 'AUTONOMOUS',
    `name` VARCHAR(100) NOT NULL,
    `categoryId` VARCHAR(191) NULL,
    `industryId` VARCHAR(191) NULL,
    `businessName` VARCHAR(160) NOT NULL DEFAULT '',
    `objective` TEXT NULL,
    `contactName` VARCHAR(100) NULL,
    `contactGender` VARCHAR(16) NOT NULL DEFAULT 'male',
    `contactPhone` VARCHAR(20) NULL,
    `executiveName` VARCHAR(40) NOT NULL DEFAULT 'Thaara',
    `companyName` VARCHAR(100) NOT NULL DEFAULT 'Kagzso Technology Services',
    `callbackNumber` VARCHAR(20) NULL,
    `personality` VARCHAR(20) NOT NULL DEFAULT 'professional',
    `instructions` TEXT NULL,
    `targetDurationSec` INTEGER NOT NULL DEFAULT 60,
    `maxDurationSec` INTEGER NOT NULL DEFAULT 105,
    `callFlowId` VARCHAR(191) NULL,
    `guidedFlowId` VARCHAR(191) NULL,
    `publishedHash` VARCHAR(64) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_agents_callFlowId_key`(`callFlowId`),
    INDEX `ai_agents_language_archivedAt_idx`(`language`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_knowledge_files` (
    `id` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `format` VARCHAR(8) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `status` ENUM('EXTRACTED', 'FAILED', 'REPLACED') NOT NULL DEFAULT 'EXTRACTED',
    `error` TEXT NULL,
    `itemCount` INTEGER NOT NULL DEFAULT 0,
    `replacedById` VARCHAR(191) NULL,
    `uploadedByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_agent_knowledge_files_agentId_idx`(`agentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agent_knowledge_items` (
    `id` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `fileId` VARCHAR(191) NULL,
    `kind` VARCHAR(8) NOT NULL,
    `topic` VARCHAR(40) NOT NULL,
    `text` TEXT NOT NULL,
    `questions` JSON NULL,
    `always` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('DRAFT', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    `issues` JSON NULL,
    `source` VARCHAR(80) NULL,
    `industryHint` VARCHAR(80) NULL,
    `decidedByEmail` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_agent_knowledge_items_agentId_status_idx`(`agentId`, `status`),
    INDEX `ai_agent_knowledge_items_fileId_idx`(`fileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_industries` ADD CONSTRAINT `ai_industries_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `ai_business_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agents` ADD CONSTRAINT `ai_agents_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `ai_business_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agents` ADD CONSTRAINT `ai_agents_industryId_fkey` FOREIGN KEY (`industryId`) REFERENCES `ai_industries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agents` ADD CONSTRAINT `ai_agents_callFlowId_fkey` FOREIGN KEY (`callFlowId`) REFERENCES `call_flows`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agents` ADD CONSTRAINT `ai_agents_guidedFlowId_fkey` FOREIGN KEY (`guidedFlowId`) REFERENCES `call_flows`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agent_knowledge_files` ADD CONSTRAINT `ai_agent_knowledge_files_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `ai_agents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agent_knowledge_items` ADD CONSTRAINT `ai_agent_knowledge_items_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `ai_agents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_agent_knowledge_items` ADD CONSTRAINT `ai_agent_knowledge_items_fileId_fkey` FOREIGN KEY (`fileId`) REFERENCES `ai_agent_knowledge_files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- The contact's gender: never guessed. "unspecified" = a neutral greeting (no sir / madam).
ALTER TABLE `ai_agents`
    ADD CONSTRAINT `ai_agents_contactGender_check` CHECK (`contactGender` IN ('male', 'female', 'unspecified'));

-- Starter library (admins edit it in Settings → AI agent industries). Discovery topics are things to ask
-- about, not claims that every Kagzso product supports them.
INSERT INTO `ai_business_categories` (`id`, `name`, `createdAt`, `updatedAt`) VALUES
    ('aicat_healthcare', 'Healthcare', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aicat_hospitality', 'Hospitality', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aicat_education', 'Education', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aicat_technology', 'Technology', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `ai_industries` (`id`, `categoryId`, `name`, `discoveryTopics`, `createdAt`, `updatedAt`) VALUES
    ('aiind_hospital', 'aicat_healthcare', 'Hospital', 'Hospital administration\nPatient registration and workflows\nBilling\nAppointments\nRepetitive follow-ups and reminders', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aiind_hotel', 'aicat_hospitality', 'Hotel / Restaurant', 'Kitchen order tickets (KOT)\nPoint of sale (POS)\nHotel management (HMS)\nReservations\nKitchen operations', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aiind_school', 'aicat_education', 'School', 'Attendance\nTimetable\nAdministration\nParent and student communication', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('aiind_it', 'aicat_technology', 'IT company', 'Software development\nInternal workflows\nAI automation of repetitive work', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
