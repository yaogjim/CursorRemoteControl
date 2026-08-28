import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  topicRoutingLogLine,
  topicRoutingUserMessage,
  type TopicRoutingFailureReason,
} from '../src/server/transports/telegram/topic-routing.js';
import {
  ensureTopicWindow,
  handleTextMessage,
  type CommandDeps,
} from '../src/server/transports/telegram/commands.js';
import type { BotContext } from '../src/server/transports/telegram/tg-types.js';
import type { TopicManager, TopicMapping } from '../src/server/transports/telegram/topic-manager.js';

const REASONS: TopicRoutingFailureReason[] = [
  'no_thread',
  'unmapped_thread',
  'window_not_found',
  'switch_window_failed',
  'switch_tab_failed',
  'approval_unroutable',
  'questionnaire_unroutable',
  'topic_create_failed',
];

describe('topicRoutingUserMessage', () => {
  it('returns an actionable warning for every routing failure reason', () => {
    for (const reason of REASONS) {
      const msg = topicRoutingUserMessage(reason, {
        windowTitle: 'proj',
        tabTitle: 'Chat 1',
        threadId: 42,
        error: 'boom',
        knownWindows: ['other'],
      });
      assert.match(msg, /⚠️/);
      assert.ok(msg.length > 20, reason);
    }
  });

  it('tells the user to send inside a mapped forum topic', () => {
    assert.match(topicRoutingUserMessage('no_thread'), /forum topic/i);
    assert.match(topicRoutingUserMessage('no_thread'), /\/sync/);
  });

  it('includes open windows when the mapped window is missing', () => {
    const msg = topicRoutingUserMessage('window_not_found', {
      windowTitle: 'missing-proj',
      knownWindows: ['alpha', 'beta'],
    });
    assert.match(msg, /missing-proj/);
    assert.match(msg, /alpha, beta/);
  });

  it('includes the underlying error for switch failures', () => {
    assert.match(
      topicRoutingUserMessage('switch_window_failed', { error: 'cdp timeout' }),
      /cdp timeout/,
    );
    assert.match(
      topicRoutingUserMessage('switch_tab_failed', { tabTitle: 'Agent', error: 'not found' }),
      /not found/,
    );
  });
});

describe('topicRoutingLogLine', () => {
  it('is a diagnostic log line and not a Cursor state field', () => {
    const line = topicRoutingLogLine('approval_unroutable', {
      windowTitle: 'proj',
      tabTitle: 'Chat 1',
      threadId: 7,
    });
    assert.match(line, /\[telegram\] Topic routing failed: approval_unroutable/);
    assert.match(line, /thread=7/);
    assert.match(line, /window="proj"/);
    assert.match(line, /tab="Chat 1"/);
    assert.ok(!line.includes('state:patch'));
  });
});

function stubCtx(message: BotContext['message']): { ctx: BotContext; replies: string[] } {
  const replies: string[] = [];
  const ctx: BotContext = {
    message,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    editMessageText: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { ctx, replies };
}

function stubDeps(resolveThread: (threadId: number) => TopicMapping | undefined): CommandDeps {
  return {
    topicManager: { resolveThread } as TopicManager,
  } as CommandDeps;
}

describe('handleTextMessage routing diagnostics', () => {
  it('silently ignores General-topic messages without a threadId', async () => {
    const { ctx, replies } = stubCtx({ text: 'please fix this' });
    await handleTextMessage(ctx, stubDeps(() => undefined));
    assert.equal(replies.length, 0);
    await handleTextMessage(ctx, stubDeps(() => undefined));
    assert.equal(replies.length, 0, 'must not reply on every General message');
  });

  it('replies with unmapped_thread when the topic has no mapping', async () => {
    const { ctx, replies } = stubCtx({ text: 'please fix this', message_thread_id: 99 });
    await handleTextMessage(ctx, stubDeps(() => undefined));
    assert.equal(replies.length, 1);
    assert.equal(replies[0], topicRoutingUserMessage('unmapped_thread', { threadId: 99 }));
  });
});

describe('ensureTopicWindow routing diagnostics', () => {
  it('replies and returns false for an unmapped thread', async () => {
    const { ctx, replies } = stubCtx({ text: '/status', message_thread_id: 12 });
    const ok = await ensureTopicWindow(ctx, stubDeps(() => undefined));
    assert.equal(ok, false);
    assert.equal(replies.length, 1);
    assert.equal(replies[0], topicRoutingUserMessage('unmapped_thread', { threadId: 12 }));
  });
});