import type { ModeCapability, ModelCapability, ModelCapabilitySnapshot, ToolCapability } from './types.js';
import { dedupeCapabilities, normalizeMode, normalizeModel, normalizeTool } from './capability-normalize.js';

export interface CapabilityDomSnapshot {
  modes?: Array<Partial<ModeCapability> & { id?: unknown; label?: unknown }>;
  models?: { items?: Array<Partial<ModelCapability> & { id?: unknown; label?: unknown }>; completeness?: ModelCapabilitySnapshot['completeness']; filterActive?: boolean; observedAt?: number };
  tools?: Array<Partial<ToolCapability> & { id?: unknown; type?: unknown }>;
  composerReady?: boolean;
  observedAt?: number;
}

export interface ExtractedCapabilities {
  composerReady: boolean;
  modes: ModeCapability[];
  models: ModelCapabilitySnapshot;
  tools: ToolCapability[];
}

export function extractCapabilities(snapshot: CapabilityDomSnapshot): ExtractedCapabilities {
  const observedAt = snapshot.observedAt ?? Date.now();
  const modes = dedupeCapabilities((snapshot.modes ?? []).map(normalizeMode).filter((x): x is ModeCapability => !!x));
  const modelItems = dedupeCapabilities((snapshot.models?.items ?? []).map(normalizeModel).filter((x): x is ModelCapability => !!x));
  const tools = dedupeCapabilities((snapshot.tools ?? []).map(normalizeTool).filter((x): x is ToolCapability => !!x));
  return {
    composerReady: snapshot.composerReady === true || modes.length > 0 || modelItems.length > 0 || tools.length > 0,
    modes,
    models: {
      items: modelItems,
      completeness: snapshot.models?.completeness ?? 'unknown',
      filterActive: snapshot.models?.filterActive === true,
      observedAt: snapshot.models?.observedAt ?? observedAt,
    },
    tools,
  };
}

/** Fixed browser-side passive probe. It only reads DOM and never mutates UI. */
export const SEMANTIC_PASSIVE_PROBE_JS = `(() => {
  const visible = (el) => { if (!(el instanceof Element)) return false; const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const all = (selector) => { try { return [...document.querySelectorAll(selector)]; } catch { return []; } };
  const modes = []; const modeSeen = new Set();
  for (const raw of all('[data-mode], [data-mode-id], [aria-current="true"][role="button"], [aria-selected="true"][role="option"]')) {
    if (!visible(raw) || raw.hasAttribute('data-stop-button')) continue;
    // Cursor 3.x puts data-mode on both the composer container and its mode
    // dropdown. Prefer the dropdown so its text does not include the model.
    const el = raw.matches('.composer-unified-dropdown, [data-mode-id]')
      ? raw
      : (raw.querySelector('.composer-unified-dropdown[data-mode], .composer-unified-dropdown[data-mode-id]') || raw.closest('.composer-unified-dropdown') || raw);
    if (!visible(el) || el.hasAttribute('data-stop-button')) continue;
    const id = el.getAttribute('data-mode') || el.getAttribute('data-mode-id') || el.getAttribute('data-value') || '';
    if (!id || modeSeen.has(id)) continue; modeSeen.add(id);
    const label = text(el.querySelector(':scope > div > span') || el.querySelector(':scope span') || el) || id;
    const current = el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-mode') === id;
    modes.push({ id, label, current, source: el.hasAttribute('data-mode') ? 'data_attribute' : 'aria', confidence: el.hasAttribute('data-mode') ? 1 : .8, scope:'composer', selectable:true, observedAt:Date.now() });
  }
  const modelCandidates = [
    ...all('[data-model], [data-model-id], .vscode-model-picker__trigger, .ui-model-picker__trigger, [class*="model-picker" i]'),
  ];
  let selectedModel = null;
  for (const el of modelCandidates) {
    if (!visible(el) || el.matches('[data-stop-button]')) continue;
    const label = text(el.querySelector('.vscode-model-picker__trigger-text, [data-model-label], span') || el);
    if (!label || /model picker|select model|shell command options/i.test(label)) continue;
    selectedModel={ id: el.getAttribute('data-model-id') || el.getAttribute('data-model') || 'label::'+label, label, selected:true, scope:'composer', idStability: el.id && !/^_r_[a-z0-9]+_$/.test(el.id) ? 'stable':'label', source:el.hasAttribute('data-model')||el.hasAttribute('data-model-id')?'data_attribute':'aria', confidence:el.classList.contains('vscode-model-picker__trigger') ? .95 : .75, selectable:true, observedAt:Date.now() }; break;
  }
  const tools=[]; const seenTools=new Set();
  for (const el of all('[data-tool-call-id], [data-tool-name], [data-tool-type]')) { if (!visible(el)) continue; const id=el.getAttribute('data-tool-call-id') || el.getAttribute('data-tool-name') || ''; if (!id || seenTools.has(id)) continue; seenTools.add(id); const type=el.getAttribute('data-tool-type') || el.getAttribute('data-tool-name') || 'generic_tool'; tools.push({id,type,source:'data_attribute',executable:false,actions:[]}); }
  return { composerReady:modes.length>0 || !!selectedModel || tools.length>0, modes, models:{items:selectedModel?[selectedModel]:[], completeness:'unknown', filterActive:false, observedAt:Date.now()}, tools, observedAt:Date.now() };
})()`;