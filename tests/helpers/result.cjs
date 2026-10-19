'use strict';

/**
 * Reads an execution tool result the way a calling model does: from its text.
 * Execution results carry no structuredContent (CONTEXT-001), so every field a caller acts
 * on is parsed from the answer and the footer; a footer line in any other format fails the
 * parse, which keeps the documented format under test. Both result styles are read: `framed`
 * (answer and footer each in a plaintext block) and `raw` (Codex: plain lines).
 */
const STATUS = /^(?<provider>\S+) · (?<model>.+?) · (?<duration>\d+\.\d)s(?: · (?<ops>\d+) ops?)?(?: · (?:session_handle=)?(?<handle>\S+) \((?:turn (?<turn>\d+), )?(?<state>ready|finished)(?<noHistory>, no history)?\))?$/;
const ERROR = /^Error \[(?<code>[A-Z_]+)(?<retryable>, retryable)?\]: (?<message>[\s\S]*)$/;
/** A plaintext block: a fence longer than any backtick run inside it. */
const FRAME = /^(?<fence>`{3,})plaintext\n(?<content>[\s\S]*)\n\k<fence>$/;

/** Returns the content of a framed block unchanged; an unframed block fails the parse. */
function unframe(text) {
  const frame = FRAME.exec(text);
  if (!frame) throw new Error(`block is not framed: ${text}`);
  return frame.groups.content;
}

/** Splits a result into its body and footer text in either style. */
function split(text) {
  const fence = /`{3,}$/.exec(text)?.[0];
  if (fence) {
    const opening = text.lastIndexOf(`${fence}plaintext\n`);
    if (opening < 2 || text.slice(opening - 2, opening) !== '\n\n') throw new Error(`no framed footer in: ${text}`);
    return { style: 'framed', body: text.slice(0, opening - 2), footer: unframe(text.slice(opening)) };
  }
  const at = text.lastIndexOf('\n\nCoAgent8: ');
  if (at < 0) throw new Error(`no CoAgent8 footer in: ${text}`);
  return { style: 'raw', body: text.slice(0, at), footer: text.slice(at + 2) };
}

function readResult(result) {
  if (result && typeof result === 'object' && !result.content && 'result' in result && 'meta' in result) {
    const { formatExecutionResult } = require('../../src/mcp/result.ts');
    result = formatExecutionResult(result);
  }
  if (result.structuredContent !== undefined) throw new Error('execution results carry no structuredContent');
  if (result.content.length !== 1 || result.content[0].type !== 'text') throw new Error('execution results carry one text block');
  const text = result.content[0].text;
  const { style, body, footer } = split(text);
  const answerOf = block => style === 'framed' ? unframe(block) : block;
  const [statusLine, ...lines] = footer.split('\n');
  if (!statusLine.startsWith('CoAgent8: ')) throw new Error(`unexpected footer line: ${statusLine}`);
  const status = STATUS.exec(statusLine.slice('CoAgent8: '.length));
  if (!status) throw new Error(`unexpected footer line: ${statusLine}`);
  // The server's own no-answer placeholders are the only bodies outside a frame.
  const placeholder = body === 'CLI completed with no public text.' || body === 'No public response.';
  const parsed = {
    text, style, provider: status.groups.provider, model: status.groups.model,
    durationSec: Number(status.groups.duration), ops: Number(status.groups.ops || 0),
    sessionHandle: status.groups.handle || null, turn: status.groups.turn ? Number(status.groups.turn) : (status.groups.handle ? 1 : null),
    state: status.groups.state || null, continuationAvailable: status.groups.state === 'ready', historyAvailable: !status.groups.noHistory,
    status: 'completed',
    verdict: 'NOT_APPLICABLE', reason: null, truncated: false, warnings: [], issueUrl: null, workspace: null, denials: [],
    error: null, answer: placeholder || /^Error \[/.test(body) ? body : answerOf(body), price: null,
  };
  const error = /^Error \[/.test(body) ? ERROR.exec(body.split('\n\n')[0]) : null;
  if (error) {
    parsed.error = { code: error.groups.code, retryable: Boolean(error.groups.retryable), message: error.groups.message };
    parsed.status = { ABORTED: 'cancelled', TIMEOUT: 'timed_out' }[parsed.error.code] || 'failed';
    const partial = body.indexOf('\n\nPartial response:\n\n');
    parsed.answer = partial < 0 ? '' : answerOf(body.slice(partial + '\n\nPartial response:\n\n'.length));
  }
  for (const line of lines) {
    let match;
    if ((match = /^Verdict: (READY|BLOCKED)(?: \((.*)\))?$/.exec(line))) { parsed.verdict = match[1]; parsed.reason = match[2] || null; }
    else if (line === 'Notice: Output reached buffer limit.') parsed.truncated = true;
    else if ((match = /^Price: (.+)$/.exec(line))) parsed.price = match[1];
    else if ((match = /^Usage: (.+)$/.exec(line))) parsed.usage = match[1];
    else if ((match = /^Warning: (.*)$/.exec(line))) parsed.warnings.push(match[1]);
    else if ((match = /^Report this issue: (https:\/\/\S+) \(the issue tool prepares the sanitized report to paste\)$/.exec(line))) parsed.issueUrl = match[1];
    else if ((match = /^Workspace: (.+) \(server directory\)$/.exec(line))) parsed.workspace = match[1];
    else if ((match = /^Denied \(observed from tool events\): (.*)$/.exec(line))) parsed.denials.push(match[1]);
    else throw new Error(`unexpected footer line: ${line}`);
  }
  return parsed;
}

module.exports = { readResult };
