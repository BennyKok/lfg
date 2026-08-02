-- Older refreshes updated agent/path independently while retaining backend,
-- resume_handle and model with COALESCE. That could turn a Codex rollout into
-- an impossible `agent=codex, backend=aisdk, model=opus` tuple and route a
-- resume through the wrong provider family.
UPDATE resumable_sessions
SET backend = NULL,
    resume_handle = NULL,
    model = NULL,
    managed = 0
WHERE backend IS NOT NULL
  AND NOT (
    (agent = 'claude' AND backend = 'aisdk') OR
    (agent = 'codex' AND backend = 'codex-aisdk') OR
    (agent = 'opencode' AND backend = 'opencode') OR
    (agent = 'pi' AND backend = 'pi')
  );

PRAGMA user_version = 4;
