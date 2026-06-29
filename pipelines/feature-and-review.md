---
name: feature-and-review
title: "Build → Review → Deploy"
steps:
  - agent: claude
    prompt: >
      Build the feature described below end-to-end. Write the code, tests,
      and make sure it is working before you finish.

      FEATURE: (replace this line with your feature description)
    model: opus
    context: none

  - agent: codex
    prompt: >
      You have been handed off a codebase where the previous agent (Claude) just
      implemented a new feature. Review ALL of its changes carefully:

      1. Hunt for bugs, logic errors, and edge cases.
      2. Check for security issues (injection, auth bypasses, missing validation).
      3. Verify tests cover the happy path and key failure modes.
      4. Fix every issue you find directly — do not just report them.

      When done, summarize what you found and fixed.
    context: transcript_summary

  - run: "echo 'Deploy step — replace this with: npm run deploy, or fly deploy, etc.'"
---

A three-step pipeline: Claude builds a feature, Codex reviews and fixes it, then
a shell command deploys it. Copy this file and customize the prompts and deploy command
for your project.

Usage via API:
  POST /api/pipelines/feature-and-review/run
  Body: { "cwd": "/path/to/your/repo" }
