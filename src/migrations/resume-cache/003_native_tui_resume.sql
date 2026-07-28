UPDATE resumable_sessions
SET resumable = 1
WHERE agent IN ('grok', 'cursor');

PRAGMA user_version = 3;
