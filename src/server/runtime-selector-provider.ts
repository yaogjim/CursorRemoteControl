import { createHash } from 'crypto';
import type { CdpClient } from './cdp-client.js';
import type { EndpointIdentity, SelectorConfig, CapabilityKind } from './types.js';
import type { AdapterStoreData, AdapterRecord } from './adapter-store.js';
import { AdapterRegistry } from './adapter-registry.js';

export interface RuntimeAdapterContext {
  endpointFingerprint: string;
  cursorBuild: string;
  domSignature: string;
  targetId: string;
  targetGeneration: number;
  observedAt: number;
}

export interface RuntimeAdapterUsage {
  source: 'builtin' | 'adapter';
  adapterId: string;
  fingerprint: string;
}

const KIND_SELECTOR_KEYS: Record<CapabilityKind, ReadonlySet<string>> = {
  mode: new Set(['modeTrigger', 'modeDropdown']),
  model: new Set(['modelTrigger', 'modelDropdown']),
  tool: new Set(['toolAction', 'approveButton', 'rejectButton']),
};

function cloneSelectors(selectors: SelectorConfig): SelectorConfig {
  return JSON.parse(JSON.stringify(selectors)) as SelectorConfig;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function replaceSelectorConfig(target: SelectorConfig, source: SelectorConfig): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    target[key] = {
      strategies: [...value.strategies],
      ...(value.textMatch ? { textMatch: [...value.textMatch] } : {}),
    };
  }
}

export function endpointFingerprint(identity: EndpointIdentity): string {
  if (!identity.verified || identity.browserFamily !== 'cursor' || !identity.product) return '';
  return hash({ family: identity.browserFamily, product: identity.product, protocolVersion: identity.protocolVersion });
}

/**
 * Structural fingerprint from a fixed allowlist of semantic presence signals.
 * It deliberately excludes target ids, workspace paths, text, counts that vary
 * with chat history, and menu open/closed state.
 */
export async function probeDomSignature(client: CdpClient): Promise<string> {
  const signals = await client.evaluate(`(() => ({
    workbench: !!document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar, .monaco-workbench'),
    vscodeRuntime: typeof globalThis.vscode === 'object',
    composerData: !!document.querySelector('[data-composer-id]'),
    composerBar: !!document.querySelector('.composer-bar'),
    modeData: !!document.querySelector('[data-mode]'),
    modeIdData: !!document.querySelector('[data-mode-id]'),
    modelData: !!document.querySelector('[data-model]'),
    modelIdData: !!document.querySelector('[data-model-id]'),
    vscodeModelTrigger: !!document.querySelector('.vscode-model-picker__trigger'),
    uiModelTrigger: !!document.querySelector('.ui-model-picker__trigger'),
    contentEditable: !!document.querySelector('[contenteditable="true"]'),
    textArea: !!document.querySelector('textarea'),
    roleTextbox: !!document.querySelector('[role="textbox"]'),
    workbenchUrl: /workbench/i.test(location.href),
  }))()`);
  return hash(signals);
}

export function adapterMatchesContext(adapter: AdapterRecord, context: RuntimeAdapterContext, kind: CapabilityKind): boolean {
  return adapter.status === 'active'
    && adapter.capabilityKinds.includes(kind)
    && adapter.cursorVersionRange === context.cursorBuild
    && adapter.domSignature === context.domSignature
    && adapter.endpointFingerprint === context.endpointFingerprint;
}

/**
 * Owns the mutable selector object shared by active-target production modules.
 * A local adapter can replace only keys belonging to its capability kind and
 * only when endpoint, Cursor build, and DOM fingerprint all match exactly.
 */
export class RuntimeSelectorProvider {
  readonly selectors: SelectorConfig;
  private readonly baseline: SelectorConfig;
  private readonly registry: AdapterRegistry;
  private context: RuntimeAdapterContext | null = null;
  private usage: Record<CapabilityKind, RuntimeAdapterUsage> = {
    mode: { source: 'builtin', adapterId: '', fingerprint: '' },
    model: { source: 'builtin', adapterId: '', fingerprint: '' },
    tool: { source: 'builtin', adapterId: '', fingerprint: '' },
  };

  constructor(baseline: SelectorConfig, data: AdapterStoreData) {
    this.baseline = cloneSelectors(baseline);
    this.selectors = cloneSelectors(baseline);
    this.registry = new AdapterRegistry({ builtin: [], local: data.adapters, bindings: data.activeBindings });
  }

  updateStore(data: AdapterStoreData): void {
    this.registry.update({ builtin: [], local: data.adapters, bindings: data.activeBindings });
    this.recomputeActive();
  }

  setActiveContext(context: RuntimeAdapterContext): void {
    this.context = { ...context };
    this.recomputeActive();
  }

  clearActiveContext(): void {
    this.context = null;
    this.recomputeActive();
  }

  getContext(): RuntimeAdapterContext | null {
    return this.context ? { ...this.context } : null;
  }

  getUsage(): Record<CapabilityKind, RuntimeAdapterUsage> {
    return JSON.parse(JSON.stringify(this.usage)) as Record<CapabilityKind, RuntimeAdapterUsage>;
  }

  getAdapterBindings(): Partial<Record<CapabilityKind, string>> {
    return Object.fromEntries(
      (Object.entries(this.usage) as Array<[CapabilityKind, RuntimeAdapterUsage]>)
        .map(([kind, value]) => [kind, value.source === 'adapter' ? value.adapterId : '']),
    ) as Partial<Record<CapabilityKind, string>>;
  }

  resolveForContext(context: RuntimeAdapterContext): SelectorConfig {
    return this.resolve(context).selectors;
  }

  status(): { context: RuntimeAdapterContext | null; usage: Record<CapabilityKind, RuntimeAdapterUsage> } {
    return { context: this.getContext(), usage: this.getUsage() };
  }

  private recomputeActive(): void {
    const resolved = this.context
      ? this.resolve(this.context)
      : {
          selectors: cloneSelectors(this.baseline),
          usage: {
            mode: { source: 'builtin', adapterId: '', fingerprint: '' },
            model: { source: 'builtin', adapterId: '', fingerprint: '' },
            tool: { source: 'builtin', adapterId: '', fingerprint: '' },
          } as Record<CapabilityKind, RuntimeAdapterUsage>,
        };
    replaceSelectorConfig(this.selectors, resolved.selectors);
    this.usage = resolved.usage;
  }

  private resolve(context: RuntimeAdapterContext): { selectors: SelectorConfig; usage: Record<CapabilityKind, RuntimeAdapterUsage> } {
    const selectors = cloneSelectors(this.baseline);
    const usage: Record<CapabilityKind, RuntimeAdapterUsage> = {
      mode: { source: 'builtin', adapterId: '', fingerprint: '' },
      model: { source: 'builtin', adapterId: '', fingerprint: '' },
      tool: { source: 'builtin', adapterId: '', fingerprint: '' },
    };
    for (const kind of ['mode', 'model', 'tool'] as CapabilityKind[]) {
      const match = this.registry.find(kind, context.cursorBuild, context.domSignature, context.endpointFingerprint);
      const adapter = match.adapter;
      if (!adapter || !adapterMatchesContext(adapter, context, kind)) continue;
      for (const [key, strategies] of Object.entries(adapter.strategies)) {
        if (!KIND_SELECTOR_KEYS[kind].has(key)) continue;
        selectors[key] = {
          ...(selectors[key]?.textMatch ? { textMatch: [...selectors[key].textMatch!] } : {}),
          strategies: strategies.map((strategy) => strategy.selector),
        };
      }
      usage[kind] = { source: 'adapter', adapterId: adapter.id, fingerprint: match.fingerprint };
    }
    return { selectors, usage };
  }
}