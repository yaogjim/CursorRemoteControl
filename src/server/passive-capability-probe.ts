import type { CdpClient } from './cdp-client.js';
import type { CapabilitySummary, ModeCapability, ModelCapabilitySnapshot, ToolCapability } from './types.js';
import { mergeModeCatalog, mergeModelCatalog } from './capability-diff.js';
import { extractCapabilities, type CapabilityDomSnapshot } from './capability-extractor.js';

export interface PassiveCapabilityObservation {
  composerReady: boolean;
  modes: ModeCapability[];
  models: ModelCapabilitySnapshot;
  tools: ToolCapability[];
  observedAt: number;
}

/**
 * A passive probe proves the current selection, not the complete selectable
 * inventory. Preserve a previously verified complete inventory while updating
 * only the selected/current flags. Unknown observations must never downgrade
 * a complete interactive snapshot by themselves.
 */
export function mergePassiveCapabilityObservation(
  previous: CapabilitySummary | null,
  observed: PassiveCapabilityObservation,
): Pick<CapabilitySummary, 'modes' | 'models' | 'tools'> & { completeness: ModelCapabilitySnapshot['completeness'] } {
  const modes = mergeModeCatalog(previous?.modes, observed.modes);
  const models = mergeModelCatalog(previous?.models, observed.models);
  return {
    modes,
    models,
    tools: observed.tools,
    completeness: models.completeness,
  };
}

/**
 * Read-only capability probe. The script is fixed server code: callers may
 * supply selector values, but never JavaScript. It does not click, focus,
 * scroll, open menus, or execute a caller-provided expression.
 */
export async function probePassiveCapabilities(
  client: CdpClient,
  modeSelectors: string[] = [],
  modelSelectors: string[] = [],
): Promise<PassiveCapabilityObservation> {
  const observedAt = Date.now();
  const selectorFallbacks = JSON.stringify({ mode: modeSelectors, model: modelSelectors });
  const script = `(() => {
    const fallback = ${selectorFallbacks};
    const visible = (el) => { if (!(el instanceof Element)) return false; const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    const all = (selector) => { try { return [...document.querySelectorAll(selector)]; } catch { return []; } };
    const queryFallback = (keys) => { for (const selector of keys) for (const el of all(selector)) if (visible(el)) return el; return null; };
    const modes = []; const modeSeen = new Set();
    for (const raw of [...all('[data-mode]'), ...all('[data-mode-id]'), ...all('[aria-current="true"][role="button"]'), ...all('[aria-selected="true"][role="option"]')]) {
      if (!visible(raw) || raw.hasAttribute('data-stop-button')) continue;
      const el = raw.matches('.composer-unified-dropdown, [data-mode-id]')
        ? raw
        : (raw.querySelector('.composer-unified-dropdown[data-mode], .composer-unified-dropdown[data-mode-id]') || raw.closest('.composer-unified-dropdown') || raw);
      if (!visible(el) || el.hasAttribute('data-stop-button')) continue;
      const id = el.getAttribute('data-mode') || el.getAttribute('data-mode-id') || el.getAttribute('data-value') || '';
      if (!id || modeSeen.has(id)) continue; modeSeen.add(id);
      const label = (el.getAttribute('aria-label') || (el.querySelector(':scope > div > span') || el.querySelector(':scope span') || el).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) || id;
      modes.push({ id, label, current:el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-mode') === id, source:el.hasAttribute('data-mode')?'data_attribute':'aria', confidence:el.hasAttribute('data-mode')?1:.8, scope:'composer', selectable:true, observedAt:${observedAt} });
    }
    const selected = queryFallback(fallback.model) || [...all('.vscode-model-picker__trigger, .ui-model-picker__trigger, [data-model], [data-model-id], [aria-label*="model" i]')].find(visible);
    let model = null;
    if (selected) {
      const label = (selected.querySelector('.vscode-model-picker__trigger-text, [data-model-label], span') || selected).textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) || '';
      if (label && !/model picker|select model|shell command options/i.test(label)) model={id:selected.getAttribute('data-model-id') || selected.getAttribute('data-model') || 'label::'+label, label, selected:true, scope:'composer', idStability:selected.id && !/^_r_[a-z0-9]+_$/.test(selected.id)?'stable':'label', source:selected.hasAttribute('data-model')||selected.hasAttribute('data-model-id')?'data_attribute':'aria', confidence:selected.classList.contains('vscode-model-picker__trigger') ? .95 : .75, selectable:true, observedAt:${observedAt}};
    }
    const tools=[]; const seenTools=new Set();
    for (const el of [...all('[data-tool-call-id]'), ...all('[data-tool-name]'), ...all('[data-tool-type]')]) { if (!visible(el)) continue; const id=el.getAttribute('data-tool-call-id') || el.getAttribute('data-tool-name') || ''; if (!id || seenTools.has(id)) continue; seenTools.add(id); tools.push({id,type:el.getAttribute('data-tool-type') || el.getAttribute('data-tool-name') || 'generic_tool',source:'data_attribute',executable:false,actions:[]}); }
    return { composerReady:modes.length>0 || !!model || tools.length>0, modes, models:{items:model?[model]:[], completeness:'unknown', filterActive:false, observedAt:${observedAt}}, tools, observedAt:${observedAt} };
  })()`;
  const result = await client.evaluate(script) as CapabilityDomSnapshot | null;
  if (!result) throw new Error('Passive capability probe returned no result');
  const normalized = extractCapabilities(result);
  return { ...normalized, observedAt: typeof result.observedAt === 'number' ? result.observedAt : observedAt };
}