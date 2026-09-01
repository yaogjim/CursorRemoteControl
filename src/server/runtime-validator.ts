import type { CdpClient } from './cdp-client.js';
import { validateSelector } from './selector-validation.js';

export interface RuntimeValidationResult { ok: boolean; selector: string; count: number; visibleCount: number; unique: boolean; error?: string; }

export async function validateSelectorRuntime(client: CdpClient, selector: string, scopeSelector?: string): Promise<RuntimeValidationResult> {
  const staticCheck = validateSelector(selector);
  if (!staticCheck.ok) return { ok: false, selector, count: 0, visibleCount: 0, unique: false, error: staticCheck.error };
  const result = await client.evaluate(`(() => { const selector=${JSON.stringify(selector)}, scope=${JSON.stringify(scopeSelector ?? '')}; let root=document; try { if (scope) root=document.querySelector(scope); const all=root?[...root.querySelectorAll(selector)]:[]; const visible=all.filter(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&!el.hasAttribute('disabled')&&el.getAttribute('aria-disabled')!=='true';}); return {count:all.length,visibleCount:visible.length}; } catch { return {count:0,visibleCount:0,error:'runtime selector rejected'}; } })()`) as { count: number; visibleCount: number; error?: string };
  return { ok: !result.error && result.visibleCount === 1, selector, count: result.count, visibleCount: result.visibleCount, unique: result.visibleCount === 1, ...(result.error ? { error: result.error } : {}) };
}

export class RuntimeValidator {
  async validateSelector(client: CdpClient, selector: string, scopeSelector?: string): Promise<RuntimeValidationResult> { return validateSelectorRuntime(client, selector, scopeSelector); }
  async validateCandidate(client: CdpClient, selectors: string[], scopeSelector?: string): Promise<RuntimeValidationResult> {
    for (const selector of selectors) { const result = await this.validateSelector(client, selector, scopeSelector); if (result.ok) return result; }
    return { ok: false, selector: selectors[0] ?? '', count: 0, visibleCount: 0, unique: false, error: 'no unique visible selector candidate' };
  }
}