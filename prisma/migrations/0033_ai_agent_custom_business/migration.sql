-- AI Agents: a category / industry typed by hand for one agent ("Other – Enter manually" in the Business
-- section; packages/shared/src/aiAgents.ts aiAgentInput customCategory / customIndustry).
-- Additive only: two nullable columns on ai_agents. Existing rows stay NULL (they keep their library
-- categoryId / industryId exactly as they are). The shared library tables (ai_business_categories,
-- ai_industries) are not touched: typed names are never added to them. No call flow or call history changes.
-- Undo: down.sql.

-- AlterTable
ALTER TABLE `ai_agents`
    ADD COLUMN `customCategory` VARCHAR(80) NULL,
    ADD COLUMN `customIndustry` VARCHAR(80) NULL;
