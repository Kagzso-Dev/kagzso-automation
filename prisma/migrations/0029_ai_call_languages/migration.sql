-- AI calls in more languages: one voice backend per language (VOICE_BACKEND_URL_<CODE>).
-- Call flows and saved AI call customers belong to one language. Additive only: two new
-- columns with a default, so every existing flow and customer is English ('en') exactly as
-- before, and nothing else in either table changes.
ALTER TABLE `call_flows` ADD COLUMN `language` VARCHAR(8) NOT NULL DEFAULT 'en';

CREATE INDEX `call_flows_language_idx` ON `call_flows`(`language`);

ALTER TABLE `ai_call_customers` ADD COLUMN `language` VARCHAR(8) NOT NULL DEFAULT 'en';

CREATE INDEX `ai_call_customers_language_deletedAt_idx` ON `ai_call_customers`(`language`, `deletedAt`);
