-- Rollback for 0031_ai_agents (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0031_ai_agents
-- ). Drops only the five AI agent tables. Call flows generated from agents stay (as ordinary flows),
-- and so do their published versions and every call run's history.
DROP TABLE IF EXISTS `ai_agent_knowledge_items`;
DROP TABLE IF EXISTS `ai_agent_knowledge_files`;
DROP TABLE IF EXISTS `ai_agents`;
DROP TABLE IF EXISTS `ai_industries`;
DROP TABLE IF EXISTS `ai_business_categories`;
