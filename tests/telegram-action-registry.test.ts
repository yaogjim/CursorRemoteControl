import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleCallbackQuery, type CommandDeps } from '../src/server/transports/telegram/commands.js';
import type { BotContext } from '../src/server/transports/telegram/tg-types.js';
import type { CommandResult } from '../src/server/types.js';

interface RecordedAction {
  actionId: string;
  actionType: string | undefined;
}

function context(data: string): { ctx: BotContext; answers: string[] } {
  const answers: string[] = [];
  return {
    answers,
    ctx: {
      callbackQuery: { data, id: 'callback-1' },
      reply: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      answerCallbackQuery: async (options) => {
        if (options?.text) answers.push(options.text);
      },
    },
  };
}

function dependencies(actions: RecordedAction[], resolve = true): CommandDeps {
  return {
    messageTracker: {
      resolveActionHash: () => resolve ? 'act_authorized' : undefined,
    },
    commandExecutor: {
      clickRegisteredAction: async (
        commandId: string,
        actionId: string,
        expected?: { actionType?: string },
      ): Promise<CommandResult> => {
        actions.push({ actionId, actionType: expected?.actionType });
        return { commandId, ok: true };
      },
    },
  } as unknown as CommandDeps;
}

describe('Telegram ActionRegistry callback protocol', () => {
  it('binds every callback prefix to its exact ActionRegistry type', async () => {
    const cases: Array<{ data: string; expected: string; answer: string }> = [
      { data: 'apr:tool:hash0001', expected: 'approve', answer: 'Approved' },
      { data: 'rej:tool:hash0001', expected: 'reject', answer: 'Rejected' },
      { data: 'all:tool:hash0001', expected: 'approve_all', answer: 'Accepted All' },
      { data: 'run:tool:hash0001', expected: 'run', answer: 'Running' },
      { data: 'skp:tool:hash0001', expected: 'skip', answer: 'Skipped' },
      { data: 'alw:tool:hash0001', expected: 'allow', answer: 'Allowed' },
      { data: 'bld:plan:hash0001', expected: 'build', answer: 'Building' },
      { data: 'qan:hash0001', expected: 'questionnaire_option', answer: 'Answered' },
      { data: 'qsk:hash0001', expected: 'skip', answer: 'Skipped' },
      { data: 'qco:hash0001', expected: 'continue', answer: 'Continued' },
    ];

    for (const item of cases) {
      const actions: RecordedAction[] = [];
      const { ctx, answers } = context(item.data);
      await handleCallbackQuery(ctx, dependencies(actions));
      assert.deepEqual(actions, [{ actionId: 'act_authorized', actionType: item.expected }], item.data);
      assert.equal(answers[0], item.answer, item.data);
    }
  });

  it('rejects missing hashes without calling the executor', async () => {
    const actions: RecordedAction[] = [];
    const { ctx, answers } = context('run:tool:expired1');
    await handleCallbackQuery(ctx, dependencies(actions, false));
    assert.deepEqual(actions, []);
    assert.match(answers[0] ?? '', /no longer pending/i);
  });

  it('rejects unknown callback prefixes without calling the executor', async () => {
    const actions: RecordedAction[] = [];
    const { ctx, answers } = context('xyz:tool:hash0001');
    await handleCallbackQuery(ctx, dependencies(actions));
    assert.deepEqual(actions, []);
    assert.equal(answers[0], 'Unknown: xyz');
  });
});