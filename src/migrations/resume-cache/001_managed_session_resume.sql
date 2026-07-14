BEGIN;

ALTER TABLE resumable_sessions ADD COLUMN backend TEXT;
ALTER TABLE resumable_sessions ADD COLUMN resume_handle TEXT;
ALTER TABLE resumable_sessions ADD COLUMN model TEXT;
ALTER TABLE resumable_sessions ADD COLUMN assigned_user TEXT;
ALTER TABLE resumable_sessions ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;

PRAGMA user_version = 1;

COMMIT;
