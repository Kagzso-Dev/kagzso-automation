-- Rollback for 0035_template_delete_keeps_send_history (not run by Prisma; apply by hand). Puts back the old rule
-- (a template used by a bulk send can't be deleted). It only works while every batch still has its template:
-- batches whose template was deleted (templateId IS NULL) must be removed first, or the MODIFY ... NOT NULL fails.
-- Check with: SELECT COUNT(*) FROM `ManualSendBatch` WHERE `templateId` IS NULL;
--
-- Then remove 0035 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0035_template_delete_keeps_send_history';
ALTER TABLE `ManualSendBatch` DROP FOREIGN KEY `ManualSendBatch_templateId_fkey`;

ALTER TABLE `ManualSendBatch` DROP COLUMN `deletedTemplateName`,
    MODIFY `templateId` VARCHAR(191) NOT NULL;

ALTER TABLE `ManualSendBatch` ADD CONSTRAINT `ManualSendBatch_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `Template`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
