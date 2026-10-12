---
name: coagent8-session
description: List CoAgent8 sessions, read a session's history, close a session or cancel its running turn through the CoAgent8 session and cancel tools. Use when the user wants to continue an earlier consult or review, see what another agent answered, stop a long-running call, or clean up sessions.
---

# CoAgent8 sessions

- List: call `session` with `action: list`.
- History: call `session` with `action: history` and the `session_handle`; page
  with `cursor` and `limit`. Event `sequence` is the stored log position; public
  history combines or filters events, so sequence gaps do not mean lost events.
- Continue: call consult or review again with the same `session_handle`. That
  keeps the other agent's context; a call without it starts from nothing.
- Cancel: call `cancel` with the `session_handle` to stop the running turn. The
  session is not closed.
- Close: call `session` with `action: close` when the conversation is finished.
  `delete_history: true` also deletes its history; ask the user before deleting.

The handle is in the footer of every consult or review result. Pass
`workspace_path` only when the session belongs to a different repository than
the current workspace.
