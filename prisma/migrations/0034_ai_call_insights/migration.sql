-- Call insights after an Autonomous AI Agent's call: how the customer felt (sentiment) and how interested they were
-- (insights JSON: sentiment at the start and end, interest level, objections, not-interested reason, requirement).
-- Read after the call by the voice backend (app/services/customer_questions.py), kept by apps/api
-- domain/aiCallInsights.ts. Additive only: two nullable columns on ai_call_logs. Existing rows and every other call
-- stay NULL; the outcome, the customer's stage and follow-ups are not affected. Undo: down.sql.

-- AlterTable
ALTER TABLE `ai_call_logs`
    ADD COLUMN `sentiment` VARCHAR(16) NULL,
    ADD COLUMN `insights` JSON NULL;
