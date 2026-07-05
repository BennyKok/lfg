# Agent Instructions

## Local Repro Servers

- Bind ad hoc repro/static servers to loopback only. Use
  `python3 -m http.server --bind 127.0.0.1 <port>` or the equivalent
  localhost-only flag for other tools.
- Do not start throwaway repro servers on `0.0.0.0`. If a server must be shared,
  put a private tunnel or Tailscale Serve in front of a loopback listener.
- Stop any repro server you start before ending the session, especially when it
  runs from `/tmp`, a worktree, or generated build output.
