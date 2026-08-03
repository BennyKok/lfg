-- Historical enrichment previously treated a same-cwd managed record as the
-- exact session and copied that record's title across unrelated transcripts.
-- Force derived, non-managed rows through one fresh enrichment pass so already
-- cached bad titles are repaired after upgrading.
UPDATE resumable_sessions
SET mtime_ms = -1
WHERE managed = 0;

PRAGMA user_version = 5;
