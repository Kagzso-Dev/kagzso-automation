-- Rollback for 0033_ai_agent_custom_business (not run by Prisma; apply by hand). Drops only the two typed
-- category / industry columns of ai_agents. Agents that used them then have no category / industry (edit them
-- to pick one); flows already published keep the business context they were published with.
--
-- Then remove 0033 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0033_ai_agent_custom_business';
ALTER TABLE `ai_agents`
    DROP COLUMN `customCategory`,
    DROP COLUMN `customIndustry`;
