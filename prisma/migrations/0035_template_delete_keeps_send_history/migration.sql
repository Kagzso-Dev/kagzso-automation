-- An email template that was used for a bulk send (Contacts → send to selected, listed in the Send Queue) can now be
-- deleted. Before, the batch's link to the template blocked the delete (ON DELETE RESTRICT → 500 on the Templates page).
-- Now the delete clears that link (templateId → NULL) and keeps the template's name in deletedTemplateName, so the
-- Send Queue still shows which email went out. Every existing batch keeps its template; nothing is deleted here.
-- Undo: down.sql.

-- DropForeignKey
ALTER TABLE `ManualSendBatch` DROP FOREIGN KEY `ManualSendBatch_templateId_fkey`;

-- AlterTable
ALTER TABLE `ManualSendBatch` ADD COLUMN `deletedTemplateName` VARCHAR(191) NULL,
    MODIFY `templateId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `ManualSendBatch` ADD CONSTRAINT `ManualSendBatch_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `Template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
