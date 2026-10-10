// Node helpers for the guard: a ledger kept as one JSON line per verdict, and a key kept next to it.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateKeyPair } from './crypto.mjs';

export async function fileLedger(path) {
  await mkdir(dirname(path), { recursive: true });
  let rows = null;
  const load = async () => {
    if (rows) return rows;
    let text = '';
    try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    rows = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    return rows;
  };
  return {
    path,
    async entries() { return load(); },
    async append(entry) { await load(); await appendFile(path, JSON.stringify(entry) + '\n'); rows.push(entry); },
  };
}

/** Load the signing key at path, or make one (file mode 600). The key signs verdicts only; it never holds money. */
export async function fileKey(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(dirname(path), { recursive: true });
  const k = await generateKeyPair();
  await writeFile(path, JSON.stringify(k), { mode: 0o600 });
  return k;
}
