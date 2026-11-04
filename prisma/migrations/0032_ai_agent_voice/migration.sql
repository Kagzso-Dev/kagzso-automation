-- AI Agents: the AI's own voice (Settings → AI Voice; packages/shared/src/aiAgents.ts AI_AGENT_VOICE_*).
-- Additive only: four nullable columns on ai_agents. No other table changes; no call flow or call history changes.
--   voiceId           Sarvam Bulbul speaker id as the language's voice backend lists it (e.g. roopa)
--   voiceGender       female | male - the VOICE's gender, independent of contactGender (the customer's)
--   voiceDisplayName  the backend's display name (e.g. Roopa)
--   voiceLanguage     the agent's language when the voice was picked (e.g. ta)
-- Existing Tamil agents with no voice get Roopa (the requested default). Their LIVE calls don't change until an
-- admin publishes the agent again (the agent shows "unpublished changes"). Other languages stay NULL = the voice
-- backend's default voice, exactly as before.
-- Undo: down.sql.

-- AlterTable
ALTER TABLE `ai_agents`
    ADD COLUMN `voiceId` VARCHAR(64) NULL,
    ADD COLUMN `voiceGender` VARCHAR(8) NULL,
    ADD COLUMN `voiceDisplayName` VARCHAR(40) NULL,
    ADD COLUMN `voiceLanguage` VARCHAR(8) NULL;

ALTER TABLE `ai_agents`
    ADD CONSTRAINT `ai_agents_voiceGender_check` CHECK (`voiceGender` IS NULL OR `voiceGender` IN ('female', 'male'));

-- Default existing Tamil agents to Roopa (only those with no voice yet).
UPDATE `ai_agents`
    SET `voiceId` = 'roopa', `voiceGender` = 'female', `voiceDisplayName` = 'Roopa', `voiceLanguage` = 'ta'
    WHERE `language` = 'ta' AND `voiceId` IS NULL;
