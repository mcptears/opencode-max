import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** ESM-safe replacement for __dirname (works from dist/ and src/). */
export const DIRNAME: string = path.dirname(fileURLToPath(import.meta.url));

/** Project root: dist/ and src/ both sit one level below it. */
export function projectRoot(): string {
  return path.resolve(DIRNAME, '..');
}
