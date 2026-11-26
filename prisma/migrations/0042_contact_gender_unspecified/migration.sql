-- AI Call Customers ("Voicecall Contact"): a gender can now be Not specified ("unspecified") as well as Male or Female.
-- 1. The CHECK constraint from 0026 is replaced by one that also allows "unspecified".
-- 2. The column default becomes "unspecified", so a contact saved without a gender is never silently Male.
-- No row is changed: every existing contact keeps the Male or Female it has.
--
-- Undo (run by hand if ever needed; first set any "unspecified" rows to male or female):
--   UPDATE `ai_call_customers` SET `gender` = 'male' WHERE `gender` = 'unspecified';
--   ALTER TABLE `ai_call_customers` DROP CHECK `ai_call_customers_gender_check`;
--   ALTER TABLE `ai_call_customers` ADD CONSTRAINT `ai_call_customers_gender_check` CHECK (`gender` IN ('male', 'female'));
--   ALTER TABLE `ai_call_customers` ALTER COLUMN `gender` SET DEFAULT 'male';
ALTER TABLE `ai_call_customers` DROP CHECK `ai_call_customers_gender_check`;

ALTER TABLE `ai_call_customers`
    ADD CONSTRAINT `ai_call_customers_gender_check` CHECK (`gender` IN ('male', 'female', 'unspecified'));

ALTER TABLE `ai_call_customers` ALTER COLUMN `gender` SET DEFAULT 'unspecified';
