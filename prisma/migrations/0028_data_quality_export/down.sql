-- Rollback for 0028_data_quality_export (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0028_data_quality_export
-- ). Removes only what 0028 added: the export audit log and the two stored-original-row columns.
-- Every Data Quality job, row, score and review stays; no other table is touched.
DROP TABLE IF EXISTS `data_quality_export_logs`;
ALTER TABLE `data_quality_records` DROP COLUMN `raw`;
ALTER TABLE `data_quality_jobs` DROP COLUMN `headers`;
