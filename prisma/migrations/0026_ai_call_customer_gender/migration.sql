-- AI Call Customers ("Voicecall Contact"): gender is Male or Female only, Male by default.
-- 1. Every existing "unknown", empty or unrecognised gender becomes "male". Rows that are already
--    male or female are not touched (the case is normalised, e.g. "Female" -> "female").
-- 2. The column default becomes "male" and a CHECK constraint allows only "male" / "female".
-- Nothing else in the table changes.
--
-- Undo (run by hand if ever needed; the values changed in step 1 can't be restored):
--   ALTER TABLE `ai_call_customers` DROP CHECK `ai_call_customers_gender_check`;
--   ALTER TABLE `ai_call_customers` ALTER COLUMN `gender` SET DEFAULT 'unknown';
UPDATE `ai_call_customers`
SET `gender` = 'male'
WHERE `gender` IS NULL OR LOWER(TRIM(`gender`)) NOT IN ('male', 'female');

UPDATE `ai_call_customers`
SET `gender` = LOWER(TRIM(`gender`))
WHERE BINARY `gender` <> BINARY LOWER(TRIM(`gender`));

ALTER TABLE `ai_call_customers` ALTER COLUMN `gender` SET DEFAULT 'male';

ALTER TABLE `ai_call_customers`
    ADD CONSTRAINT `ai_call_customers_gender_check` CHECK (`gender` IN ('male', 'female'));
