-- 009_launch_signature_nullable.sql — recovered/imported pets may not have a
-- launch signature (the tx wasn't submitted through the normal flow).
-- Normal launches always provide one.
ALTER TABLE pets ALTER COLUMN launch_signature DROP NOT NULL;
