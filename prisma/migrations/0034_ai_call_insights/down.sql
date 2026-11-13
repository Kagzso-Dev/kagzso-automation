-- Rollback for 0034_ai_call_insights (not run by Prisma; apply by hand). Drops only the two call-insight columns of
-- ai_call_logs: the sentiment and insights kept for past calls are lost; calls, outcomes, stages, transcripts and the
-- customers' timelines stay as they are.
--
-- Then remove 0034 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0034_ai_call_insights';
ALTER TABLE `ai_call_logs`
    DROP COLUMN `sentiment`,
    DROP COLUMN `insights`;
