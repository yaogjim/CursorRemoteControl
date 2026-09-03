import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import type { PlanTodo } from './types.js';

export const MAX_PLAN_FILE_BYTES = 1024 * 1024;

export interface PlanFileData {
  todos: PlanTodo[];
  body: string;
}

export type PlanFileReadError =
  | 'invalid_path'
  | 'not_found'
  | 'not_regular_file'
  | 'too_large'
  | 'read_failed';

export type PlanFileReadResult =
  | { ok: true; data: PlanFileData }
  | { ok: false; error: PlanFileReadError };

function defaultPlansRoot(): string {
  return resolve(homedir(), '.cursor', 'plans');
}

/**
 * Resolve `label` to a file path that is strictly inside `plansRoot`.
 * Returns null for empty labels, absolute paths, NUL bytes, or any
 * traversal that would escape the plans directory.
 */
export function resolvePlanFilePath(
  label: string,
  plansRoot: string = defaultPlansRoot(),
): string | null {
  if (typeof label !== 'string' || label.length === 0) return null;
  if (label.includes('\0') || isAbsolute(label)) return null;

  const root = resolve(plansRoot);
  const candidate = resolve(root, label);
  const rel = relative(root, candidate);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;

  return candidate;
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export function readPlanFileResult(
  label: string,
  plansRoot: string = defaultPlansRoot(),
): PlanFileReadResult {
  const planPath = resolvePlanFilePath(label, plansRoot);
  if (!planPath) return { ok: false, error: 'invalid_path' };

  let fd: number | null = null;
  try {
    const realRoot = realpathSync(resolve(plansRoot));
    const pathStat = lstatSync(planPath);
    if (pathStat.isSymbolicLink()) return { ok: false, error: 'invalid_path' };
    if (!pathStat.isFile()) return { ok: false, error: 'not_regular_file' };
    if (pathStat.size > MAX_PLAN_FILE_BYTES) return { ok: false, error: 'too_large' };

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(planPath, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: 'not_regular_file' };
    if (stat.size > MAX_PLAN_FILE_BYTES) return { ok: false, error: 'too_large' };

    const realFile = realpathSync(planPath);
    if (!pathIsInside(realRoot, realFile)) return { ok: false, error: 'invalid_path' };

    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const finalStat = fstatSync(fd);
    if (finalStat.size > MAX_PLAN_FILE_BYTES) return { ok: false, error: 'too_large' };
    if (finalStat.size !== stat.size || offset !== stat.size) return { ok: false, error: 'read_failed' };

    return { ok: true, data: parsePlanMd(bytes.toString('utf-8')) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    if (code === 'ENOENT') return { ok: false, error: 'not_found' };
    if (code === 'ELOOP') return { ok: false, error: 'invalid_path' };
    if (code === 'EISDIR') return { ok: false, error: 'not_regular_file' };
    return { ok: false, error: 'read_failed' };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function readPlanFile(
  label: string,
  plansRoot: string = defaultPlansRoot(),
): PlanFileData | null {
  const result = readPlanFileResult(label, plansRoot);
  return result.ok ? result.data : null;
}

export function parsePlanMd(raw: string): PlanFileData {
  const todos: PlanTodo[] = [];
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    const fm = fmMatch[1];
    const todoRe = /- id:\s*\S+\n\s+content:\s*["']?(.*?)["']?\s*\n\s+status:\s*(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = todoRe.exec(fm)) !== null) {
      const status = m[2] as PlanTodo['status'];
      todos.push({ text: m[1], status });
    }
  }

  return { todos, body: body.trim() };
}

export function markdownToWebHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (inCodeBlock) {
      if (line.startsWith('```')) {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (line.startsWith('```')) {
      inCodeBlock = true;
      codeLang = line.slice(3).trim();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      out.push(`<h${level}>${inlineMarkdown(line.slice(level).trim())}</h${level}>`);
      continue;
    }

    if (line.match(/^\s*[-*]\s/)) {
      const content = line.replace(/^\s*[-*]\s+/, '');
      out.push(`<li>${inlineMarkdown(content)}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (olMatch) {
      out.push(`<li>${inlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.match(/^\|[\s:-]+\|$/)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => `<td>${inlineMarkdown(c.trim())}</td>`);
      out.push(`<table><tbody><tr>${cells.join('')}</tr></tbody></table>`);
      continue;
    }

    if (line.trim() === '') {
      out.push('');
      continue;
    }

    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return out.join('\n').replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
}

function inlineMarkdown(text: string): string {
  let result = escapeHtml(text);
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<em>$1</em>');
  result = result.replace(/`([^`]+?)`/g, '<code>$1</code>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (href.startsWith('http')) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }
    return `<code>${escapeHtml(label)}</code>`;
  });
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
