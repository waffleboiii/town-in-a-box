// @ts-check
/**
 * The two shared JSON files used by the API, loaded in ONE place.
 *
 * Why plain JavaScript (with JSDoc types) instead of TypeScript in web/api?
 * Vercel compiles .ts functions with the project's own TypeScript package, and TypeScript 7
 * (used by this project) no longer offers the old compiler API that Vercel calls. Plain .js
 * files need no compilation at all, so the deploy cannot break on that. The types are still
 * checked: `npx tsc -p tsconfig.api.json` (checkJs).
 *
 * Why read the files from disk? Simple, works the same in Node.js (Vercel) and in Vite (local
 * dev). vercel.json -> functions -> includeFiles makes sure Vercel ships shared/*.json.
 *
 * Files under web/api/_lib/ are helpers, not routes: Vercel ignores paths starting with "_".
 */
import { readFileSync } from 'node:fs';

/** @param {string} relativePath path relative to this file */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

/**
 * @typedef {{ system: string, user: string, schema: Record<string, unknown> }} PromptTask
 * @typedef {{
 *   profile: { template: string, renderings?: Record<string, unknown> },
 *   reaction: PromptTask,
 *   ask: PromptTask,
 *   conversation: PromptTask,
 * }} Prompts
 * @typedef {{
 *   llmDefaults: { baseUrl: string, modelReaction: string, modelConversation: string, modelSynthesis: string },
 * }} SharedConfig
 */

/** @type {Prompts} web/shared/prompts.json (owned by the simulation engine) */
export const prompts = readJson('../../shared/prompts.json');

/** @type {SharedConfig} web/shared/config.json */
export const config = readJson('../../shared/config.json');
