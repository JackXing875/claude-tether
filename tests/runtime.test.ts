import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ClaudeEventDecoder,
  claudeArgs,
  encodeUserTurn,
  workerEnvironment,
} from '../packages/runtime-adapter/claude.js';
import type { RuntimeEvent } from '../packages/runtime-adapter/claude.js';
import { toolNames } from '../packages/protocol/index.js';

const runtimeId = randomUUID();
const init = {
  type: 'system',
  subtype: 'init',
  session_id: runtimeId,
  tools: toolNames.map((t) => 'mcp__local_bridge__' + t),
};
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: runtimeId,
  result: '你好',
};
function send(decoder: ClaudeEventDecoder, message: unknown) {
  decoder.feed(Buffer.from(JSON.stringify(message) + '\n'));
}

void test('runtime contract uses explicit tools, session ID, safe argv, and no OAuth-breaking bare flag', () => {
  const args = claudeArgs({
    mcpConfig: '/private path/mcp.json',
    context: 'target: local Windows',
    resumeId: runtimeId,
  });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/private path/mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(
    !args.includes('--bare') &&
      !args.includes('--continue') &&
      !args.includes('--dangerously-skip-permissions'),
  );
  assert.ok(!args.some((arg) => arg.includes('*')));
  assert.equal(
    JSON.parse(encodeUserTurn('$(no-shell)\n中文')).message.content,
    '$(no-shell)\n中文',
  );
});

void test('auth contamination fails with names only and the worker receives an explicit env allowlist', () => {
  assert.throws(
    () => workerEnvironment({ HOME: '/private', ANTHROPIC_API_KEY: 'do-not-print' }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('ANTHROPIC_API_KEY') &&
      !error.message.includes('do-not-print'),
  );
  assert.deepEqual(
    workerEnvironment({
      HOME: '/private',
      PATH: '/bin',
      LOCAL_SECRET: 'hidden',
      NODE_OPTIONS: '--import injected',
    }),
    {
      HOME: '/private',
      PATH: '/bin',
      DISABLE_AUTOUPDATER: '1',
    },
  );
});

void test('NDJSON parser handles fragmented UTF-8 and suppresses duplicate assistant/result text', () => {
  const events: RuntimeEvent[] = [],
    decoder = new ClaudeEventDecoder((event) => events.push(event));
  const messages = [
    init,
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'future_event', secret: 'must not propagate' },
    result,
  ];
  for (const byte of Buffer.from(messages.map((m) => JSON.stringify(m)).join('\n') + '\n'))
    decoder.feed(Buffer.from([byte]));
  decoder.end();
  assert.equal(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join(''),
    '你好',
  );
  assert.deepEqual(
    events.find((e) => e.type === 'unknown'),
    { type: 'unknown', event_type: 'future_event' },
  );
});

void test('missing result, remote tools, and unexpected runtime session fail closed', () => {
  const incomplete = new ClaudeEventDecoder(() => {});
  send(incomplete, init);
  assert.throws(() => incomplete.end(), { code: 'RUNTIME_INCOMPLETE' });
  assert.throws(() => send(new ClaudeEventDecoder(() => {}), { ...init, tools: ['Bash'] }), {
    code: 'REMOTE_TOOL_EXPOSED',
  });
  const decoder = new ClaudeEventDecoder(() => {});
  send(decoder, init);
  assert.throws(() => send(decoder, { ...result, session_id: randomUUID() }), {
    code: 'RUNTIME_PROTOCOL',
  });
});
