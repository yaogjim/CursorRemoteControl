import { randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';

/**
 * Write `data` to `filePath` via a same-directory temp file + rename so
 * readers never see a truncated JSON file if the process dies mid-write.
 * Creates parent directories as needed.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  );
  try {
    writeFileSync(tmpPath, data, 'utf-8');
    try {
      const fd = openSync(tmpPath, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // fsync is best-effort; the rename still avoids torn reads.
    }
    try {
      renameSync(tmpPath, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows cannot replace an existing dest with rename().
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
        if (existsSync(filePath)) unlinkSync(filePath);
        renameSync(tmpPath, filePath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** JSON.stringify + atomic write. Always UTF-8 with a trailing newline. */
export function writeJsonAtomic(filePath: string, value: unknown, space?: number): void {
  const json = space === undefined ? JSON.stringify(value) : JSON.stringify(value, null, space);
  writeFileAtomic(filePath, json.endsWith('\n') ? json : `${json}\n`);
}