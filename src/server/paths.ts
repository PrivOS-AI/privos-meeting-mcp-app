/**
 * Filesystem anchors. Resolved from this module's own location rather than
 * `process.cwd()` so the server behaves the same whether it is started by
 * `npm run dev`, by pm2, or from inside a container image.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo root: `src/server/..`. The server always runs from source via `tsx`
 * (`npm run dev` / `npm start`), so there is no separate compiled-server output.
 */
export const repoRoot = path.resolve(moduleDir, '..', '..');

/** Vite build output that gets inlined into the served UI document. */
export const uiDistDir = path.join(repoRoot, 'dist', 'ui');

/**
 * Durable app-private scratch (decoded audio temp for embedding, job scratch).
 * Audio durability itself lives in PrivOS Files, not here (QĐ-13).
 */
export const dataDir = process.env.MEETING_DATA_DIR || path.join(repoRoot, 'data');

/** Directory holding the ONNX speaker-embedding model, fetched at deploy time. */
export const modelsDir = path.join(repoRoot, 'models');
