ALTER TABLE resumable_sessions ADD COLUMN resumable INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS resumable_sessions_user
  ON resumable_sessions(assigned_user);

PRAGMA user_version = 2;
