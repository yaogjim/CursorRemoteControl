import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  ACTION_CLICK_RESOLVER_JS,
  CommandExecutor,
  resolveActionClickTarget,
  type ActionClickTargetResult,
} from '../src/server/command-executor.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

// Questionnaire extraction and row-kind mapping live inside the serialized
// extractionFunction; keep them self-contained instead of restructuring
// production code solely for test access.

function documentFor(html: string): Document {
  return new JSDOM(html).window.document;
}

function assertElement(result: ActionClickTargetResult): Element {
  assert.ok('element' in result, 'expected resolver to return an element');
  return result.element;
}

function assertError(result: ActionClickTargetResult): string {
  assert.ok('error' in result, 'expected resolver to return an error');
  return result.error;
}

describe('action click target resolution', () => {
  it('returns the selector target when its label matches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="continue">Continue</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#continue', 'continue');

    assert.equal(assertElement(result).id, 'continue');
  });

  it('matches data-click-ready action labels from span.truncate when shortcut text is present', () => {
    const document = documentFor(`
      <main id="toolbar">
        <div id="skip" data-click-ready="true">
          <span>
            <span class="truncate">Skip</span>
            <span class="opacity-50 keybinding-font-settings">Esc</span>
          </span>
        </div>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#skip', 'Skip');

    assert.equal(assertElement(result).id, 'skip');
  });

  it('falls back to exactly one scoped text match when the selector label mismatches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="target" class="ui-button ui-9f619">Continue</button>
      </main>
      <button id="outside">Continue</button>
    `);

    const result = resolveActionClickTarget(
      document,
      '#toolbar > button#stale',
      'Continue'
    );

    assert.equal(assertElement(result).id, 'target');
  });

  it('finds a unique scoped data-click-ready action when the direct selector mismatches', () => {
    const document = documentFor(`
      <section class="composer-questionnaire-toolbar-actions">
        <button id="stale">Not Skip</button>
        <div id="skip" data-click-ready="true">
          <span>
            <span class="truncate">Skip</span>
            <span class="opacity-50 keybinding-font-settings">Esc</span>
          </span>
        </div>
      </section>
      <div id="outside" data-click-ready="true">
        <span><span class="truncate">Skip</span></span>
      </div>
    `);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-actions > button#stale',
      'Skip'
    );

    assert.equal(assertElement(result).id, 'skip');
  });

  it('continues to resolve legacy plain button actions', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="continue">Continue</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#toolbar > button#continue', 'Continue');

    assert.equal(assertElement(result).id, 'continue');
  });

  it('does not choose a target when scoped text matches are missing or ambiguous', () => {
    const zeroDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
      </main>
    `);
    const zero = resolveActionClickTarget(zeroDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(zero), /action target not found \(label: Continue\)/);

    const multipleDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="one">Continue</button>
        <button id="two" role="button">Continue</button>
      </main>
    `);
    const multiple = resolveActionClickTarget(multipleDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(multiple), /action target is ambiguous \(label: Continue\)/);
  });

  it('returns a closest button ancestor or descendant button when that label matches', () => {
    const ancestorDocument = documentFor(`
      <button id="ancestor" class="ui-button">
        <span id="inner">Continue</span>
      </button>
    `);
    const ancestor = resolveActionClickTarget(ancestorDocument, '#inner', 'Continue');

    assert.equal(assertElement(ancestor).id, 'ancestor');

    const descendantDocument = documentFor(`
      <section id="container">
        <button id="descendant" class="ui-button">Continue</button>
      </section>
    `);
    const descendant = resolveActionClickTarget(descendantDocument, '#container', 'Continue');

    assert.equal(assertElement(descendant).id, 'descendant');
  });

  // Live Cursor 3.8.23 questionnaire option row structure (public#50):
  // the row concatenates letter + label, so whole-text matching cannot work.
  const questionnaireHtml = `
    <div class="composer-questionnaire-toolbar">
      <div class="composer-questionnaire-toolbar-questions">
        <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
          <div class="composer-questionnaire-toolbar-options">
            <div id="row-a" class="composer-questionnaire-toolbar-option" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
              <span class="composer-questionnaire-toolbar-option-label">Explore the codebase architecture</span>
            </div>
            <div id="row-b" class="composer-questionnaire-toolbar-option" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
              <span class="composer-questionnaire-toolbar-option-label">Work on a new feature</span>
            </div>
            <div id="row-f" class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">C</button>
              <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  it('resolves a questionnaire option row by its label span despite the letter prefix', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)',
      'Work on a new feature'
    );

    assert.equal(assertElement(result).id, 'row-b');
  });

  it('resolves a freeform questionnaire option for the synthetic "Other" label', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(3)',
      'Other'
    );

    assert.equal(assertElement(result).id, 'row-f');
  });

  it('falls back to the unique option row matching the label when the path is stale', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(9) .composer-questionnaire-toolbar-option:nth-of-type(9)',
      'Explore the codebase architecture'
    );

    assert.equal(assertElement(result).id, 'row-a');
  });

  it('rejects an ambiguous direct selector instead of choosing its first match', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button class="approve">Approve</button>
        <button class="approve">Approve</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#toolbar > button.approve', 'Approve');

    assert.match(assertError(result), /action target is ambiguous/);
  });

  it('matches aria-label when an icon-only action has no text', () => {
    const document = documentFor('<button id="approve" aria-label="Approve"></button>');

    const result = resolveActionClickTarget(document, '#approve', 'Approve');

    assert.equal(assertElement(result).id, 'approve');
  });

  it('requires the resolved action to remain inside its registered capability scope', () => {
    const document = documentFor(`
      <section id="composer-a"><button id="outside">Approve</button></section>
      <section id="composer-b"><button id="inside">Approve</button></section>
    `);
    const capabilityScope = document.querySelector('#composer-b');

    const result = resolveActionClickTarget(document, '#outside', 'Approve', capabilityScope);

    assert.equal(assertElement(result).id, 'inside');
  });

  it('keeps the serialized browser resolver aligned with whitespace and aria-label matching', () => {
    const dom = new JSDOM('<button id="approve" aria-label="Approve   All"></button>', { runScripts: 'outside-only' });
    const result = dom.window.eval(`(() => {
      ${ACTION_CLICK_RESOLVER_JS}
      const resolved = resolveActionClickTarget(document, '#approve', 'Approve All');
      return resolved.element ? resolved.element.id : resolved.error;
    })()`);

    assert.equal(result, 'approve');
  });

  it('keeps clickAction legacy behavior when no expected label is provided', async () => {
    const clickedSelectors: string[] = [];
    let evaluateCalled = false;
    const fakeClient = {
      isConnected: () => true,
      click: async (selector: string) => {
        clickedSelectors.push(selector);
      },
      evaluate: async () => {
        evaluateCalled = true;
        return null;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.clickAction('cmd-1', '#legacy-button');

    assert.equal(result.ok, true);
    assert.deepEqual(clickedSelectors, ['#legacy-button']);
    assert.equal(evaluateCalled, false);
  });

  it('rejects hidden, disabled, and aria-disabled targets before they can be chosen', () => {
    const hidden = resolveActionClickTarget(
      documentFor('<button id="approve" hidden>Approve</button>'),
      '#approve',
      'Approve',
    );
    assert.match(assertError(hidden), /action target is hidden/);

    const disabled = resolveActionClickTarget(
      documentFor('<button id="approve" disabled>Approve</button>'),
      '#approve',
      'Approve',
    );
    assert.match(assertError(disabled), /action target is disabled/);

    const ariaDisabled = resolveActionClickTarget(
      documentFor('<button id="approve" aria-disabled="true">Approve</button>'),
      '#approve',
      'Approve',
    );
    assert.match(assertError(ariaDisabled), /action target is disabled/);
  });

  it('keeps the serialized resolver from returning a disabled or hidden element', () => {
    const run = (html: string) => {
      const dom = new JSDOM(html, { runScripts: 'outside-only' });
      return dom.window.eval(`(() => {
        ${ACTION_CLICK_RESOLVER_JS}
        const resolved = resolveActionClickTarget(document, '#approve', 'Approve');
        return resolved.element ? 'clicked' : resolved.error;
      })()`);
    };

    assert.match(String(run('<button id="approve" hidden>Approve</button>')), /action target is hidden/);
    assert.match(String(run('<button id="approve" disabled>Approve</button>')), /action target is disabled/);
    assert.match(String(run('<button id="approve" aria-disabled="true">Approve</button>')), /action target is disabled/);
  });
});
