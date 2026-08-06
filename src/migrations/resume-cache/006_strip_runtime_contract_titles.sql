-- Titles and previews derived from a transcript took the first user message
-- verbatim, but LFG wraps the first prompt of a managed session in its runtime
-- contract — so every such session cached a title of "=== LFG RUNTIME CONTRACT
-- (capability ve…" instead of what the human asked for. firstPromptTitle now
-- strips the envelope; force the affected rows through one fresh enrichment
-- pass so already cached boilerplate titles are repaired after upgrading.
UPDATE resumable_sessions
SET mtime_ms = -1
WHERE title LIKE '%=== LFG RUNTIME CONTRACT%'
   OR last_user_text LIKE '%=== LFG RUNTIME CONTRACT%';

PRAGMA user_version = 6;
