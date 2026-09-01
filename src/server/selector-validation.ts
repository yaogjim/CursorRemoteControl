import { createHash } from 'crypto';

export const ALLOWED_SELECTOR_KEYS = new Set([
  'chatContainer', 'chatInput', 'agentStatus', 'approveButton', 'rejectButton',
  'modeTrigger', 'modeDropdown', 'modelTrigger', 'modelDropdown', 'toolAction',
  'chatTabList', 'newChatButton',
]);

const MAX_SELECTOR_LENGTH = 512;
const MAX_COMBINATORS = 12;
const FORBIDDEN = /(?:javascript:|<\s*\/?(?:script|style|iframe)\b|\bon[a-z]+\s*=|[{}])/i;
const ALLOWED_PSEUDO = /:(?:scope|first-child|last-child|nth-child\(\s*\d+\s*\)|nth-of-type\(\s*\d+\s*\))/gi;

export interface SelectorValidationResult {
  ok: boolean;
  error?: string;
  normalized?: string;
  complexity: number;
}

export function validateSelector(selector: unknown): SelectorValidationResult {
  if (typeof selector !== 'string') return { ok: false, error: 'selector must be a string', complexity: 0 };
  const normalized = selector.trim();
  const complexity = (normalized.match(/[>+~]/g) ?? []).length + (normalized.match(/\*/g) ?? []).length;
  if (!normalized) return { ok: false, error: 'selector is empty', complexity: 0 };
  if (normalized.length > MAX_SELECTOR_LENGTH) return { ok: false, error: 'selector is too long', complexity };
  if (normalized.includes('\\')) return { ok: false, error: 'selector contains escape sequences', complexity };
  if (FORBIDDEN.test(normalized)) return { ok: false, error: 'selector contains forbidden syntax', complexity };
  if (complexity > MAX_COMBINATORS) return { ok: false, error: 'selector is too complex', complexity };
  const pseudoFree = normalized.replace(ALLOWED_PSEUDO, '');
  if (/:/.test(pseudoFree)) return { ok: false, error: 'selector uses a forbidden pseudo-class', complexity };
  if (!/^[\w.#\[\]="'\-\s:>+~()*^$|,]+$/.test(normalized)) {
    return { ok: false, error: 'selector contains unsupported characters', complexity };
  }
  try {
    // DOMParser is unavailable in Node; this catches common malformed forms
    // while the runtime validator performs the browser-side final check.
    if (normalized.includes(',,') || normalized.startsWith(',') || normalized.endsWith(',')) {
      return { ok: false, error: 'selector has an invalid list', complexity };
    }
  } catch { /* validation remains conservative */ }
  return { ok: true, normalized, complexity };
}

export function validateSelectorKey(key: unknown): boolean {
  return typeof key === 'string' && ALLOWED_SELECTOR_KEYS.has(key);
}

export function validateSelectorMap(input: unknown): { ok: boolean; errors: string[]; selectors: Record<string, string[]> } {
  const errors: string[] = [];
  const selectors: Record<string, string[]> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['selector map must be an object'], selectors };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!validateSelectorKey(key)) { errors.push(`unsupported selector key: ${key}`); continue; }
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 20) { errors.push(`${key} has too many strategies`); continue; }
    selectors[key] = [];
    const seen = new Set<string>();
    for (const candidate of values) {
      const result = validateSelector(candidate);
      if (!result.ok) errors.push(`${key}: ${result.error}`);
      else if (seen.has(result.normalized!)) errors.push(`${key}: duplicate selector strategy`);
      else { seen.add(result.normalized!); selectors[key].push(result.normalized!); }
    }
  }
  return { ok: errors.length === 0, errors, selectors };
}

export function selectorFingerprint(selectors: Record<string, string[]>): string {
  const canonical = Object.keys(selectors).sort().map((k) => `${k}:${[...selectors[k]].sort().join('|')}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}