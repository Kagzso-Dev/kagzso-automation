-- AI Call Customers: a number may be saved once in EACH language list (was: once in all lists).
-- Existing rows can't conflict: the old index already allowed a number only once overall, so it is
-- also only once per language. Soft-deleted rows have activePhone = NULL and are not affected.
-- The new index is created before the old one is dropped, so the table is never without one.

-- CreateIndex
CREATE UNIQUE INDEX `ai_call_customers_activePhone_language_key` ON `ai_call_customers`(`activePhone`, `language`);

-- DropIndex
DROP INDEX `ai_call_customers_activePhone_key` ON `ai_call_customers`;
