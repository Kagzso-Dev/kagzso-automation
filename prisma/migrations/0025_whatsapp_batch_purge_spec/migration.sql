-- Lead-gen purge spec kept on the batch (it used to live only in the queued job), so a
-- recipient can be deleted when Meta later confirms delivery — and never when it fails.
-- Additive and nullable: existing rows and code paths are unaffected.
ALTER TABLE `whatsapp_send_batches`
    ADD COLUMN `purgeTable` VARCHAR(16) NULL,
    ADD COLUMN `purgeIds` JSON NULL;
