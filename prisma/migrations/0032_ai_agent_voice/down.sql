-- Rollback for 0032_ai_agent_voice (not run by Prisma; apply by hand). Drops only the four voice columns of
-- ai_agents. Agents then compile with the voice backend's default voice again (after their next publish); flows
-- already published keep the voice they were published with.
--
-- Then remove 0032 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0032_ai_agent_voice';
ALTER TABLE `ai_agents` DROP CHECK `ai_agents_voiceGender_check`;
ALTER TABLE `ai_agents`
    DROP COLUMN `voiceId`,
    DROP COLUMN `voiceGender`,
    DROP COLUMN `voiceDisplayName`,
    DROP COLUMN `voiceLanguage`;
