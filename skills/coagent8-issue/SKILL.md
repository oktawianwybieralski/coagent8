---
name: coagent8-issue
description: Report a CoAgent8 defect on GitHub through the CoAgent8 issue tool, which returns a sanitized report and prefilled bug report form link for the user to review before opening or submitting. Use when CoAgent8 itself fails unexpectedly (an error, a wrong result or a setup problem) and the user wants to report it.
---

# CoAgent8 issue report

1. Write the report yourself from the conversation; do not ask the user to
   write it. Call `issue` with `title` (a short statement of the
   problem), `error_message` (the exact error) and `context` (what led to it:
   the tool, parameters, expected and actual result, impact, without secrets or
   private code). `include_doctor` defaults to true and attaches detected CLI
   versions only (no readiness or quota).
2. The server removes secrets, diffs and code blocks, returns the sanitized
   report (`title` and `body`) and the filled-in GitHub bug report form link
   without opening a browser (`opened: false` by default). Show the sanitized
   report and the link from the prompt to the user so they can review it for
   anything private first; pass `open_browser: true` only when the user asks to
   open it in the browser. Tell the user to check the form for anything private
   and click Submit new issue. When `pasteRequired` is true, the report did not
   fit in the link: ask the user to paste the full report block from the prompt
   into the form before submitting. Otherwise there is nothing to copy or paste.
3. Never submit the issue for the user.

Report problems with a backend's answer itself (a wrong opinion from the other
agent) to the user instead; an issue is for CoAgent8 defects.
