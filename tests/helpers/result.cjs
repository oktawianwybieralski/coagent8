'use strict';

/**
 * Reads an execution tool result the way a calling model does: from its markdown text.
 * Execution results carry no structuredContent (CONTEXT-001), so every field a caller acts
 * on is parsed from the answer and the quoted footer; a footer line in any other format
 * fails the parse, which keeps the documented format under test.
 */
const FOOTER = /\n\n> CoAgent8: /;
const STATUS = /^(?<provider>\S+) · (?<model>.+?) · (?<duration>\d+\.\d)s(?: · (?<ops>\d+) ops?)?(?: · (?<handle>\S+) \((?:turn (?<turn>\d+), )?(?<state>ready|finished)(?<noHistory>, no history)?\))?$/;
const ERROR = /^> Error \[(?<code>[A-Z_]+)(?<retryable>, retryable)?\]: (?<message>[\s\S]*)$/;

function readResult(result) {
  if (result.structuredContent !== undefined) throw new Error('execution results carry no structuredContent');
  if (result.content.length !== 1 || result.content[0].type !== 'text') throw new Error('execution results carry one text block');
  const text = result.content[0].text;
  const at = text.search(FOOTER);
  if (at < 0) throw new Error(`no CoAgent8 footer in: ${text}`);
  const body = text.slice(0, at);
  const [statusLine, ...lines] = text.slice(at + 2).split('\n>\n');
  const status = STATUS.exec(statusLine.slice('> CoAgent8: '.length));
  if (!status) throw new Error(`unexpected footer line: ${statusLine}`);
  const parsed = {
    text, provider: status.groups.provider, model: status.groups.model,
    durationSec: Number(status.groups.duration), ops: Number(status.groups.ops || 0),
    sessionHandle: status.groups.handle || null, turn: status.groups.turn ? Number(status.groups.turn) : (status.groups.handle ? 1 : null),
    state: status.groups.state || null, continuationAvailable: status.groups.state === 'ready', historyAvailable: !status.groups.noHistory,
    status: 'completed',
    verdict: 'NOT_APPLICABLE', reason: null, truncated: false, warnings: [], issueUrl: null, workspace: null,
    error: null, answer: body, price: null,
  };
  const error = /^> Error \[/.test(body) ? ERROR.exec(body.split('\n\n')[0]) : null;
  if (error) {
    parsed.error = { code: error.groups.code, retryable: Boolean(error.groups.retryable), message: error.groups.message };
    parsed.status = { ABORTED: 'cancelled', TIMEOUT: 'timed_out' }[parsed.error.code] || 'failed';
    const partial = body.indexOf('\n\nPartial response:\n\n');
    parsed.answer = partial < 0 ? '' : body.slice(partial + '\n\nPartial response:\n\n'.length);
  }
  for (const line of lines) {
    let match;
    if ((match = /^> Verdict: (READY|BLOCKED)(?: \(([\s\S]*)\))?$/.exec(line))) { parsed.verdict = match[1]; parsed.reason = match[2] || null; }
    else if (line === '> Notice: Output reached buffer limit.') parsed.truncated = true;
    else if ((match = /^> Price: (.+)$/.exec(line))) parsed.price = match[1];
    else if ((match = /^> Warning: ([\s\S]*)$/.exec(line))) parsed.warnings.push(match[1]);
    else if ((match = /^> Report this issue: \[Open pre-filled GitHub Issue\]\((.+)\)$/.exec(line))) parsed.issueUrl = match[1];
    else if ((match = /^> Workspace: (.+) \(server directory\)$/.exec(line))) parsed.workspace = match[1];
    else throw new Error(`unexpected footer line: ${line}`);
  }
  return parsed;
}

module.exports = { readResult };
