---
name: coagent8-issue
description: Prepare a sanitized CoAgent8 bug report with a pre-filled GitHub issue link through the CoAgent8 issue tool. Use when CoAgent8 itself fails unexpectedly (an error, a wrong result or a setup problem) and the user wants to report it.
---

# CoAgent8 issue report

1. Call `issue` with `error_message` (the exact error) and `context` (what led
   to it: the tool, parameters and expected result, without secrets or private
   code). `include_doctor` defaults to true and attaches detected CLI versions
   only (no readiness or quota).
2. The server removes secrets, diffs and code blocks. Show the user the preview
   and the link, and ask them to check it for anything private.
3. The user opens the link and submits the issue. Never submit it for them.

Report problems with a backend's answer itself (a wrong opinion from the other
agent) to the user instead; an issue is for CoAgent8 defects.
