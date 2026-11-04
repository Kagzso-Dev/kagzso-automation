-- Rollback for 0031_ai_agents (not run by Prisma; apply by hand). Drops only the five AI agent tables.
-- Call flows generated from agents stay (as ordinary, editable flows), and so do their published versions
-- and every call run's history. No other table is touched (0031 only created these five).
--
-- Then remove 0031 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   * 0031 was applied successfully (the usual case):
--       DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0031_ai_agents';
--     (`npx prisma migrate resolve --rolled-back` refuses a migration that did not fail - error P3012.)
--   * 0031 failed part-way:  npx prisma migrate resolve --rolled-back 0031_ai_agents
DROP TABLE IF EXISTS `ai_agent_knowledge_items`;
DROP TABLE IF EXISTS `ai_agent_knowledge_files`;
DROP TABLE IF EXISTS `ai_agents`;
DROP TABLE IF EXISTS `ai_industries`;
DROP TABLE IF EXISTS `ai_business_categories`;
