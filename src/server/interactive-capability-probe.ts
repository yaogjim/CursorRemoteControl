import type { CdpClient } from './cdp-client.js';
import type { ModelCapabilitySnapshot, ModeCapability } from './types.js';
import { extractCapabilities, type ExtractedCapabilities } from './capability-extractor.js';
import {
  MODEL_ITEM_HELPERS_JS,
  MODEL_MENU_COMPLETENESS_JS,
  MODEL_MENU_LOOKUP_JS,
} from './command-executor.js';

export interface InteractiveProbeOptions { modeSelectors: string[]; modelSelectors: string[]; }

export class InteractiveProbeCleanupError extends Error {
  constructor(message = 'Interactive probe failed to close the menu it opened') {
    super(message);
    this.name = 'InteractiveProbeCleanupError';
  }
}

/** Probe-private `window` slot holding the pre-open focused element. Overwritten per open. */
export const INTERACTIVE_PROBE_FOCUS_SLOT = '__cursorRemoteInteractiveProbeFocus';

const FOCUS_SLOT_EXPR = `window[${JSON.stringify(INTERACTIVE_PROBE_FOCUS_SLOT)}]`;

const REMEMBER_FOCUS_JS = `${FOCUS_SLOT_EXPR} = document.activeElement instanceof Element ? document.activeElement : null;`;

const CLEAR_FOCUS_SLOT_JS = `try { delete ${FOCUS_SLOT_EXPR}; } catch {}`;

const FOCUSABLE_EL_JS = `
  const isProbeFocusable = (el) => {
    if (!(el instanceof HTMLElement) || !el.isConnected) return false;
    if (typeof el.focus !== 'function') return false;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.tabIndex >= 0) return true;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'IFRAME') return true;
    if (tag === 'A' && el.hasAttribute('href')) return true;
    return false;
  };
`;

const RESTORE_FOCUS_JS = `
  ${FOCUSABLE_EL_JS}
  try {
    const el = ${FOCUS_SLOT_EXPR};
    if (!(el instanceof Element) || !el.isConnected || !isProbeFocusable(el)) {
      return { restored: false, skipped: true };
    }
    el.focus();
    return { restored: true, skipped: false };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    ${CLEAR_FOCUS_SLOT_JS}
  }
`;

const VISIBLE_EL_JS = `const visible = (el) => { if (!(el instanceof Element)) return false; const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0; };`;

const MENU_OPEN_JS = `
  ${MODEL_MENU_LOOKUP_JS}
  ${VISIBLE_EL_JS}
  const modeMenuOpen = [...document.querySelectorAll('[id^="composer-mode-"]')].some(visible);
  const modelMenu = findModelMenu();
  const modelMenuOpen = !!(modelMenu && visible(modelMenu));
  return modeMenuOpen || modelMenuOpen;
`;

/**
 * Interactive discovery is deliberately explicit. It opens at most one menu,
 * reads its semantic rows, and always attempts Escape in finally. It never
 * selects a model/mode or clicks a state-changing action.
 */
export async function probeInteractiveCapabilities(client: CdpClient, options: InteractiveProbeOptions): Promise<ExtractedCapabilities> {
  const modeResult = await client.evaluate(`(() => {
    const selectors=${JSON.stringify(options.modeSelectors)};
    const candidates=[];
    for(const s of selectors){try{candidates.push(...document.querySelectorAll(s));}catch{}}
    candidates.push(...document.querySelectorAll('.composer-unified-dropdown[data-mode], [data-mode-id]'));
    const triggers=[];
    for(const raw of candidates){
      const e=raw.matches('.composer-unified-dropdown, [data-mode-id]') ? raw : raw.querySelector('.composer-unified-dropdown[data-mode], [data-mode-id]');
      if(!e || e.hasAttribute('data-stop-button') || triggers.includes(e)) continue;
      const r=e.getBoundingClientRect(); if(r.width>0&&r.height>0) triggers.push(e);
    }
    if(triggers.length!==1) return {ok:false,count:triggers.length};
    ${REMEMBER_FOCUS_JS}
    try { triggers[0].click(); return {ok:true,count:1}; }
    catch (err) { ${CLEAR_FOCUS_SLOT_JS} throw err; }
  })()`) as { ok: boolean; count: number } | null;
  if (!modeResult?.ok) throw new Error(`mode menu trigger is not unique (found ${modeResult?.count ?? 0})`);
  try {
    await wait(150);
    const modes = await client.evaluate(`(() => {
      ${VISIBLE_EL_JS}
      const trigger = document.querySelector('.composer-unified-dropdown[data-mode]') || document.querySelector('[data-mode-id]');
      const currentId = trigger?.getAttribute('data-mode') || trigger?.getAttribute('data-mode-id') || '';
      const triggerId = trigger?.id || '';
      const menuPrefix = triggerId ? 'composer-mode-' + triggerId + '-' : '';
      const menuItems = [...document.querySelectorAll('[id^="composer-mode-"]')]
        .filter((el) => visible(el) && !el.hasAttribute('data-stop-button'));
      const out = []; const seen = new Set();
      for (const item of menuItems) {
        const rawId = item.id || '';
        const id = menuPrefix && rawId.startsWith(menuPrefix) ? rawId.slice(menuPrefix.length) : '';
        const label = (item.innerText || item.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!id || !label || seen.has(id)) continue;
        seen.add(id);
        const selected = item.querySelector('[data-is-selected="true"]') || item.hasAttribute('data-is-selected');
        const icon = item.querySelector('[class*="codicon-"]')?.className?.match(/codicon-[\\w-]+/)?.[0] || '';
        out.push({ id, label, current: !!selected || id === currentId, icon, source:'menu', confidence:1, scope:'composer', selectable:true, observedAt:Date.now() });
      }
      if (!out.length && currentId) out.push({ id:currentId, label:currentId, current:true, source:'data_attribute', confidence:1, scope:'composer', selectable:true, observedAt:Date.now() });
      return out;
    })()` ) as ModeCapability[];
    return extractCapabilities({ composerReady:true, modes, models:{items:[],completeness:'unknown',filterActive:false}, tools:[] });
  } finally {
    await closeMenu(client);
  }
}

export async function probeInteractiveModelMenu(client: CdpClient, selectors: string[]): Promise<ModelCapabilitySnapshot> {
  let opened=false;
  try {
    const openResult = await client.evaluate(`(() => { const selectors=${JSON.stringify(selectors)}; const candidates=[]; for(const s of selectors){try{candidates.push(...document.querySelectorAll(s));}catch{}} candidates.push(...document.querySelectorAll('.vscode-model-picker__trigger, .ui-model-picker__trigger, [data-model], [data-model-id], button[aria-label*="model" i]')); const triggers=Array.from(new Set(candidates)).filter(e=>{if((e.id||'').startsWith('plan-exec-model'))return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}); if(triggers.length!==1)return {ok:false,count:triggers.length}; ${REMEMBER_FOCUS_JS} try { triggers[0].click(); return {ok:true,count:1}; } catch (err) { ${CLEAR_FOCUS_SLOT_JS} throw err; } })()`) as { ok: boolean; count: number } | null;
    if (!openResult?.ok) throw new Error(`model menu trigger is not unique (found ${openResult?.count ?? 0})`);
    opened = true;
    await wait(250);
    const currentLabel = await client.evaluate(`(() => { const el=document.querySelector('.vscode-model-picker__trigger, .ui-model-picker__trigger'); return (el?.querySelector('.vscode-model-picker__trigger-text, span')?.textContent || el?.textContent || '').replace(/\\s+/g,' ').trim(); })()`) as string;
    const data = await client.evaluate(`(() => {
      ${MODEL_MENU_LOOKUP_JS}
      ${MODEL_ITEM_HELPERS_JS}
      ${MODEL_MENU_COMPLETENESS_JS}
      const menu=findModelMenu();
      if(!menu) return {items:[],completeness:'unknown',filterActive:false,observedAt:Date.now()};
      const items=collectModelItems(menu);
      const assessed=assessModelMenuCompleteness(menu, items.length);
      return {
        items:items.map(x=>({...x,selected:x.selected || x.label===${JSON.stringify(currentLabel)},scope:'composer',idStability:x.id.startsWith('label::')?'label':'stable',source:'menu',confidence:.9,selectable:true,observedAt:Date.now()})),
        completeness:assessed.completeness,
        filterActive:assessed.filterActive,
        observedAt:Date.now()
      };
    })()`) as ModelCapabilitySnapshot;
    return data;
  } finally {
    if (opened) await closeMenu(client);
  }
}

/** Run mode then model discovery. Cleanup failure after the mode menu aborts the model menu. */
export async function probeInteractiveModeAndModel(
  client: CdpClient,
  options: InteractiveProbeOptions,
): Promise<ExtractedCapabilities> {
  const modeResult = await probeInteractiveCapabilities(client, options);
  const models = await probeInteractiveModelMenu(client, options.modelSelectors);
  return { ...modeResult, models };
}

export async function closeMenu(client: CdpClient): Promise<void> {
  try {
    await client.pressKey('Escape', 'Escape', 27);
  } catch (err) {
    await clearFocusSlotBestEffort(client);
    throw new InteractiveProbeCleanupError(
      `Interactive probe cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let stillOpen = true;
  const closeDeadline = Date.now() + 1_000;
  try {
    while (stillOpen && Date.now() < closeDeadline) {
      await wait(25);
      stillOpen = await client.evaluate(`(() => { ${MENU_OPEN_JS} })()`) as boolean;
    }
  } catch (err) {
    await clearFocusSlotBestEffort(client);
    throw new InteractiveProbeCleanupError(
      `Interactive probe could not verify menu close: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stillOpen) {
    await clearFocusSlotBestEffort(client);
    throw new InteractiveProbeCleanupError();
  }
  await restoreFocusAfterClose(client);
}

async function restoreFocusAfterClose(client: CdpClient): Promise<void> {
  type RestoreResult = { restored?: boolean; skipped?: boolean; error?: string };
  let result: RestoreResult | null = null;
  try {
    result = await client.evaluate(`(() => { ${RESTORE_FOCUS_JS} })()`) as RestoreResult | null;
  } catch (err) {
    await clearFocusSlotBestEffort(client);
    throw new InteractiveProbeCleanupError(
      `Interactive probe focus restoration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result?.error) {
    throw new InteractiveProbeCleanupError(
      `Interactive probe focus restoration failed: ${result.error}`,
    );
  }
}

async function clearFocusSlotBestEffort(client: CdpClient): Promise<void> {
  try {
    await client.evaluate(`(() => { ${CLEAR_FOCUS_SLOT_JS} return true; })()`);
  } catch {
    // Page may already be gone; never mask the original cleanup error.
  }
}

async function wait(ms:number): Promise<void> { await new Promise(resolve=>setTimeout(resolve,ms)); }