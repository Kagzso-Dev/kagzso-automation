-- Rollback for 0027_data_quality (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0027_data_quality
-- ). Drops only the two Data Quality staging tables (records first: they reference jobs).
-- No existing table is touched; every contact, queue, call flow and history row stays as it is.
DROP TABLE IF EXISTS `data_quality_records`;
DROP TABLE IF EXISTS `data_quality_jobs`;
