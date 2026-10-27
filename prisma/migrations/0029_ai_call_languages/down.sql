-- Rollback for 0029_ai_call_languages (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0029_ai_call_languages
-- ). Drops only the two language columns: every flow and customer is English again.
-- Flows and customers made for another language stay, but show on the English pages.
DROP INDEX `call_flows_language_idx` ON `call_flows`;
ALTER TABLE `call_flows` DROP COLUMN `language`;
DROP INDEX `ai_call_customers_language_deletedAt_idx` ON `ai_call_customers`;
ALTER TABLE `ai_call_customers` DROP COLUMN `language`;
