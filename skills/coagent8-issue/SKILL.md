---
name: coagent8-issue
description: Report a CoAgent8 defect on GitHub through the CoAgent8 issue tool, which fills in the bug report form and opens it in the browser for the user to submit. Use when CoAgent8 itself fails unexpectedly (an error, a wrong result or a setup problem) and the user wants to report it.
---

# CoAgent8 issue report

1. Write the report yourself from the conversation; do not ask the user to
   write it. Call `issue` with `title` (a short statement of the
   problem), `error_message` (the exact error) and `context` (what led to it:
   the tool, parameters, expected and actual result, impact, without secrets or
   private code). `include_doctor` defaults to true and attaches detected CLI
   versions only (no readiness or quota).
2. The server removes secrets, diffs and code blocks, fills in the GitHub bug
   report form and opens it in the browser (`opened: true`). Tell the user to
   check the form for anything private and click Submit new issue. When
   `opened` is false, show the link from the prompt. When `pasteRequired` is
   true, the report did not fit in the link: ask the user to paste the full
   report block from the prompt into the form before submitting. Otherwise
   there is nothing to copy or paste.
3. Never submit the issue for the user.

Report problems with a backend's answer itself (a wrong opinion from the other
agent) to the user instead; an issue is for CoAgent8 defects.
