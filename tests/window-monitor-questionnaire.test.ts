import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { elementsSignature, questionnaireFingerprint } from '../src/server/window-monitor.js';
import type { ChatElement, Questionnaire } from '../src/server/types.js';

function makeQuestionnaire(overrides: Partial<Questionnaire> = {}): Questionnaire {
  return {
    questions: [
      {
        number: '1.',
        text: 'How should I re-land it?',
        isActive: true,
        options: [
          { letter: 'A', label: 'Push a fresh branch', isFreeform: false, selectorPath: 'a' },
          { letter: 'B', label: "Don't open a PR", isFreeform: false, selectorPath: 'b' },
        ],
      },
    ],
    activeIndex: 0,
    totalLabel: '1 of 1',
    skipSelectorPath: 'skip',
    continueSelectorPath: 'continue',
    continueDisabled: true,
    ...overrides,
  };
}

describe('questionnaireFingerprint', () => {
  it('returns empty string for null or empty questionnaires', () => {
    assert.equal(questionnaireFingerprint(null), '');
    assert.equal(
      questionnaireFingerprint(makeQuestionnaire({ questions: [] })),
      ''
    );
  });

  it('changes when a questionnaire first appears (drives the per-window emit)', () => {
    const before = questionnaireFingerprint(null);
    const after = questionnaireFingerprint(makeQuestionnaire());
    assert.notEqual(before, after);
  });

  it('changes when the active question advances', () => {
    const q1 = makeQuestionnaire({
      questions: [
        makeQuestionnaire().questions[0],
        { number: '2.', text: 'Second?', isActive: false, options: [] },
      ],
      totalLabel: '1 of 2',
      activeIndex: 0,
    });
    const q2 = makeQuestionnaire({
      questions: q1.questions,
      totalLabel: '2 of 2',
      activeIndex: 1,
    });
    assert.notEqual(questionnaireFingerprint(q1), questionnaireFingerprint(q2));
  });

  it('changes when the continue button toggles enabled/disabled', () => {
    const disabled = makeQuestionnaire({ continueDisabled: true });
    const enabled = makeQuestionnaire({ continueDisabled: false });
    assert.notEqual(questionnaireFingerprint(disabled), questionnaireFingerprint(enabled));
  });

  it('changes when an option label changes', () => {
    const first = makeQuestionnaire();
    const second = makeQuestionnaire({
      questions: [
        {
          ...first.questions[0],
          options: [
            first.questions[0].options[0],
            { ...first.questions[0].options[1], label: 'Open a focused PR' },
          ],
        },
      ],
    });

    assert.notEqual(questionnaireFingerprint(first), questionnaireFingerprint(second));
  });

  it('is stable for identical questionnaires (no spurious re-emits)', () => {
    assert.equal(
      questionnaireFingerprint(makeQuestionnaire()),
      questionnaireFingerprint(makeQuestionnaire())
    );
  });

  it('changes when an option becomes selected', () => {
    const first = makeQuestionnaire();
    const second = makeQuestionnaire({
      questions: [{
        ...first.questions[0],
        options: [
          { ...first.questions[0].options[0], selected: true },
          first.questions[0].options[1],
        ],
      }],
    });
    assert.notEqual(questionnaireFingerprint(first), questionnaireFingerprint(second));
  });
});

describe('elementsSignature', () => {
  it('changes when a non-tail tool summary or action changes', () => {
    const first: ChatElement[] = [
      {
        type: 'tool',
        id: 'tool-1',
        flatIndex: 0,
        toolCallId: 'call-1',
        status: 'loading',
        action: 'Reading',
        details: 'src/server/relay.ts',
      },
      {
        type: 'assistant',
        id: 'assistant-1',
        flatIndex: 1,
        text: 'Done',
        html: '<p>Done</p>',
        codeBlocks: [],
      },
    ];
    const detailChanged: ChatElement[] = [
      { ...first[0], details: 'src/server/window-monitor.ts' } as ChatElement,
      first[1],
    ];
    const actionChanged: ChatElement[] = [
      { ...first[0], action: 'Searched' } as ChatElement,
      first[1],
    ];

    assert.notEqual(elementsSignature(first), elementsSignature(detailChanged));
    assert.notEqual(elementsSignature(first), elementsSignature(actionChanged));
  });

  it('changes when a non-tail thought summary changes and stays stable otherwise', () => {
    const first: ChatElement[] = [
      {
        type: 'thought',
        id: 'thought-1',
        flatIndex: 0,
        duration: '2s',
        action: 'Reading',
        detail: 'src/client/app.js',
        thoughtKind: 'thinking_step',
      },
      {
        type: 'assistant',
        id: 'assistant-1',
        flatIndex: 1,
        text: 'Done',
        html: '<p>Done</p>',
        codeBlocks: [],
      },
    ];
    const changed: ChatElement[] = [
      { ...first[0], detail: 'tests/web-client.test.ts', duration: '3s' } as ChatElement,
      first[1],
    ];

    assert.equal(elementsSignature(first), elementsSignature(structuredClone(first)));
    assert.notEqual(elementsSignature(first), elementsSignature(changed));
  });
});
