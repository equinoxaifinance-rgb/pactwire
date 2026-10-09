// A Cloudflare D1-compatible wrapper over node:sqlite, so the same SQL runs locally and in tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function openD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const wrap = sql => {
    const stmt = db.prepare(sql);
    let args = [];
    const api = {
      bind: (...a) => { args = a.map(v => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)); return api; },
      first: async () => { const r = stmt.get(...args); return r ? { ...r } : null; },
      all: async () => ({ results: stmt.all(...args).map(r => ({ ...r })) }),
      run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; }
    };
    return api;
  };
  return { prepare: wrap, raw: db, close: () => db.close() };
}
