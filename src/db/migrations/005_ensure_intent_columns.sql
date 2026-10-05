-- 005_ensure_intent_columns.sql — ensure launch_intents has all columns the code expects.
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS traits JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS metadata_uri TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS launcher_wallet TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS symbol TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS pet_wallet_pubkey TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS pet_wallet_encrypted TEXT;
