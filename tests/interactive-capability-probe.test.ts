import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { CdpClient } from '../src/server/cdp-client.js';
import {
  INTERACTIVE_PROBE_FOCUS_SLOT,
  InteractiveProbeCleanupError,
  probeInteractiveCapabilities,
  probeInteractiveModelMenu,
  probeInteractiveModeAndModel,
} from '../src/server/interactive-capability-probe.js';

interface LiveDomOptions {
  closeOnEscape?: boolean;
  closeDelayMs?: number;
  overflow?: boolean;
  mountedOverflow?: boolean;
  setSize?: number;
}

function liveDomClient(options: LiveDomOptions = {}): CdpClient & {
  modelClicks: number;
  pageWindow: Window & typeof globalThis;
} {
  const closeOnEscape = options.closeOnEscape !== false;
  const dom = new JSDOM(`
    <div id="mode-trigger" class="composer-unified-dropdown" data-mode="multitask">Multitask</div>
    <button id="_r_model_" class="vscode-model-picker__trigger">gpt-HA High</button>
  `, { runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { width: 120, height: 24, top: 0, right: 120, bottom: 24, left: 0, x: 0, y: 0, toJSON() {} }; },
  });

  const modeTrigger = window.document.querySelector('#mode-trigger')!;
  modeTrigger.addEventListener('click', () => {
    if (window.document.querySelector('[id^="composer-mode-"]')) return;
    for (const [id, label] of [['agent', 'Agent'], ['multitask', 'Multitask'], ['chat', 'Ask']]) {
      const item = window.document.createElement('div');
      item.id = `composer-mode-mode-trigger-${id}`;
      item.textContent = label;
      item.tabIndex = 0;
      window.document.body.appendChild(item);
      if (id === 'agent') item.focus();
    }
  });

  const modelTrigger = window.document.querySelector('#_r_model_')!;
  const client = { modelClicks: 0 };
  modelTrigger.addEventListener('click', () => {
    client.modelClicks += 1;
    if (window.document.querySelector('[data-testid="model-picker-menu"]')) return;
    const menu = window.document.createElement('div');
    menu.setAttribute('data-testid', 'model-picker-menu');
    menu.setAttribute('role', 'menu');
    if (options.overflow) {
      Object.defineProperty(menu, 'scrollHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(menu, 'clientHeight', { configurable: true, get: () => 80 });
    } else {
      Object.defineProperty(menu, 'scrollHeight', { configurable: true, get: () => 80 });
      Object.defineProperty(menu, 'clientHeight', { configurable: true, get: () => 80 });
    }
    const search = window.document.createElement('input');
    search.value = '';
    const contentParent = options.mountedOverflow ? window.document.createElement('div') : menu;
    if (options.mountedOverflow) {
      contentParent.className = 'ui-scroll-area__viewport';
      Object.defineProperty(contentParent, 'scrollHeight', { configurable: true, get: () => 136 });
      Object.defineProperty(contentParent, 'clientHeight', { configurable: true, get: () => 80 });
      Object.defineProperty(contentParent, 'scrollTop', { configurable: true, writable: true, value: 0 });
      Object.defineProperty(contentParent, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: 120, height: 80, top: 0, right: 120, bottom: 80, left: 0, x: 0, y: 0, toJSON() {} }),
      });
      menu.appendChild(contentParent);
    }
    contentParent.appendChild(search);
    for (const [index, label] of ['gpt-HA High', 'glm5.3 High'].entries()) {
      const item = window.document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      if (options.mountedOverflow) {
        const top = 84 + index * 24;
        Object.defineProperty(item, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ width: 120, height: 24, top, right: 120, bottom: top + 24, left: 0, x: 0, y: top, toJSON() {} }),
        });
      }
      if (options.setSize) item.setAttribute('aria-setsize', String(options.setSize));
      contentParent.appendChild(item);
    }
    window.document.body.appendChild(menu);
    search.focus();
  });

  const closeMenus = () => {
    for (const el of [...window.document.querySelectorAll('[id^="composer-mode-"], [data-testid="model-picker-menu"]')]) {
      el.remove();
    }
  };

  return Object.assign(client, {
    evaluate: async (expression: string) => window.eval(expression),
    pressKey: async () => {
      if (!closeOnEscape) return;
      if (options.closeDelayMs && options.closeDelayMs > 0) {
        setTimeout(closeMenus, options.closeDelayMs);
      } else {
        closeMenus();
      }
    },
    pageWindow: window,
  }) as CdpClient & { modelClicks: number; pageWindow: Window & typeof globalThis };
}

function focusSlotPresent(win: Window): boolean {
  return Object.prototype.hasOwnProperty.call(win, INTERACTIVE_PROBE_FOCUS_SLOT);
}

function attachPriorFocus(win: Window & typeof globalThis): HTMLTextAreaElement {
  const prior = win.document.createElement('textarea');
  prior.id = 'prior-focus';
  win.document.body.appendChild(prior);
  prior.focus();
  return prior;
}

describe('interactive capability probe serialization', () => {
  it('extracts the complete mode menu without corrupting labels', async () => {
    const result = await probeInteractiveCapabilities(liveDomClient(), {
      modeSelectors: ['.composer-unified-dropdown[data-mode]'],
      modelSelectors: [],
    });

    assert.deepEqual(result.modes.map(mode => [mode.id, mode.label, mode.current]), [
      ['agent', 'Agent', false],
      ['multitask', 'Multitask', true],
      ['chat', 'Ask', false],
    ]);
  });

  it('marks an unfiltered menu complete only when all rows are mounted without overflow', async () => {
    const result = await probeInteractiveModelMenu(liveDomClient(), ['.vscode-model-picker__trigger']);

    assert.equal(result.completeness, 'complete');
    assert.equal(result.filterActive, false);
    assert.deepEqual(Array.from(result.items, model => model.label), ['gpt-HA High', 'glm5.3 High']);
    assert.deepEqual(Array.from(result.items).filter(model => model.selected).map(model => model.label), ['gpt-HA High']);
  });

  it('treats overflow as partial when mounted rows do not prove the full inventory', async () => {
    const result = await probeInteractiveModelMenu(liveDomClient({ overflow: true }), ['.vscode-model-picker__trigger']);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.filterActive, false);
    assert.equal(result.items.length, 2);
  });

  it('marks a clipped menu complete when all semantic rows cover its scroll content', async () => {
    const result = await probeInteractiveModelMenu(liveDomClient({ mountedOverflow: true }), ['.vscode-model-picker__trigger']);
    assert.equal(result.completeness, 'complete');
    assert.equal(result.filterActive, false);
    assert.deepEqual(Array.from(result.items, model => model.label), ['gpt-HA High', 'glm5.3 High']);
  });

  it('treats an aria-setsize mismatch as partial even when the search input is empty', async () => {
    const result = await probeInteractiveModelMenu(liveDomClient({ setSize: 10 }), ['.vscode-model-picker__trigger']);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.items.length, 2);
  });

  it('marks matching aria-setsize with no overflow as complete', async () => {
    const result = await probeInteractiveModelMenu(liveDomClient({ setSize: 2 }), ['.vscode-model-picker__trigger']);
    assert.equal(result.completeness, 'complete');
    assert.equal(result.items.length, 2);
  });

  it('waits for the Cursor close animation before declaring cleanup failure', async () => {
    const client = liveDomClient({ closeDelayMs: 150 });
    const prior = attachPriorFocus(client.pageWindow);

    const result = await probeInteractiveCapabilities(client, {
      modeSelectors: ['.composer-unified-dropdown[data-mode]'],
      modelSelectors: [],
    });

    assert.equal(result.modes.length, 3);
    assert.equal(client.pageWindow.document.activeElement, prior);
    assert.equal(focusSlotPresent(client.pageWindow), false);
  });

  it('throws when cleanup cannot close the menu', async () => {
    await assert.rejects(
      () => probeInteractiveCapabilities(liveDomClient({ closeOnEscape: false }), {
        modeSelectors: ['.composer-unified-dropdown[data-mode]'],
        modelSelectors: [],
      }),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveProbeCleanupError);
        return true;
      },
    );
  });

  it('restores focus to the remembered element after a successful menu close', async () => {
    const client = liveDomClient();
    const prior = attachPriorFocus(client.pageWindow);
    assert.equal(client.pageWindow.document.activeElement, prior);

    await probeInteractiveModeAndModel(client, {
      modeSelectors: ['.composer-unified-dropdown[data-mode]'],
      modelSelectors: ['.vscode-model-picker__trigger'],
    });

    assert.equal(client.pageWindow.document.activeElement, prior);
    assert.equal(focusSlotPresent(client.pageWindow), false);
    assert.equal(client.modelClicks, 1);
  });

  it('skips restoration and clears the slot when the prior element is disconnected', async () => {
    const client = liveDomClient();
    const prior = attachPriorFocus(client.pageWindow);
    client.pageWindow.document.querySelector('#mode-trigger')!.addEventListener('click', () => {
      prior.remove();
    });

    await probeInteractiveCapabilities(client, {
      modeSelectors: ['.composer-unified-dropdown[data-mode]'],
      modelSelectors: [],
    });

    assert.equal(prior.isConnected, false);
    assert.equal(focusSlotPresent(client.pageWindow), false);
    assert.notEqual(client.pageWindow.document.activeElement, prior);
  });

  it('clears the focus slot when menu close fails', async () => {
    const client = liveDomClient({ closeOnEscape: false });
    attachPriorFocus(client.pageWindow);

    await assert.rejects(
      () => probeInteractiveCapabilities(client, {
        modeSelectors: ['.composer-unified-dropdown[data-mode]'],
        modelSelectors: [],
      }),
      (err: unknown) => err instanceof InteractiveProbeCleanupError,
    );

    assert.equal(focusSlotPresent(client.pageWindow), false);
    assert.ok(client.pageWindow.document.querySelector('[id^="composer-mode-"]'));
  });

  it('reports focus restoration failure as InteractiveProbeCleanupError and still clears the slot', async () => {
    const client = liveDomClient();
    const prior = attachPriorFocus(client.pageWindow);
    prior.focus = () => {
      throw new Error('focus boom');
    };

    await assert.rejects(
      () => probeInteractiveCapabilities(client, {
        modeSelectors: ['.composer-unified-dropdown[data-mode]'],
        modelSelectors: [],
      }),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveProbeCleanupError);
        assert.match((err as Error).message, /focus restoration failed/);
        assert.match((err as Error).message, /focus boom/);
        return true;
      },
    );

    assert.equal(focusSlotPresent(client.pageWindow), false);
  });

  it('does not open the model menu after mode-menu cleanup failure', async () => {
    const client = liveDomClient({ closeOnEscape: false });
    attachPriorFocus(client.pageWindow);
    await assert.rejects(
      () => probeInteractiveModeAndModel(client, {
        modeSelectors: ['.composer-unified-dropdown[data-mode]'],
        modelSelectors: ['.vscode-model-picker__trigger'],
      }),
      (err: unknown) => err instanceof InteractiveProbeCleanupError,
    );
    assert.equal(client.modelClicks, 0);
    assert.equal(focusSlotPresent(client.pageWindow), false);
  });
});