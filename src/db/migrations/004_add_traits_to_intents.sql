-- 004_add_traits_to_intents.sql — ensure launch_intents has traits column.
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS traits JSONB NOT NULL DEFAULT '[]'::jsonb;
