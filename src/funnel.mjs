// Funnel counters: how many strangers land, try a deal, register an agent, and which MCP clients
// actually call tools. Aggregate integers per UTC day only. Nothing personal is stored: no IPs,
// no user agents, no ids. Free-text labels (ref, referer host, MCP client name) are squeezed to a
// short safe alphabet and capped per day, so the table cannot grow without bound.

const MAX_LABELS = 50;   // distinct labels kept per kind per day; the rest count as "other"
const TOP = 20;          // labels shown per kind when reading
const DAYS = 30;

const label = (s, max = 32) => {
  const v = String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  return v || 'unknown';
};
export const refLabel = s => (/^[a-z0-9-]{1,32}$/.test(String(s ?? '')) ? String(s) : 'other');
export const clientLabel = s => label(s);
export function refererHost(referer, ownHost) {
  try {
    const h = new URL(referer).hostname.toLowerCase();
    if (!h || h === ownHost) return '';
    return /^[a-z0-9.-]{1,64}$/.test(h) ? h : 'other';
  } catch { return ''; }
}

export function createFunnel(db, { now = () => new Date() } = {}) {
  const today = () => now().toISOString().slice(0, 10);
  async function bump(key) {
    const day = today();
    const up = await db.prepare('UPDATE funnel SET n = n + 1 WHERE day = ? AND key = ?').bind(day, key).run();
    if (up.meta.changes) return;
    const colon = key.indexOf(':');
    if (colon > 0) {
      const kind = key.slice(0, colon + 1);
      const row = await db.prepare("SELECT COUNT(*) AS c FROM funnel WHERE day = ? AND substr(key, 1, ?) = ?").bind(day, kind.length, kind).first();
      if ((row?.c || 0) >= MAX_LABELS) key = `${kind}other`;
    }
    await db.prepare('INSERT INTO funnel (day, key, n) VALUES (?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET n = n + 1').bind(day, key).run();
  }
  // Counting must never break or slow a real request beyond a failed write.
  const count = async (...keys) => { for (const k of keys) { try { await bump(k); } catch { /* counting is best effort */ } } };

  async function read() {
    const since = new Date(now().getTime() - (DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const { results } = await db.prepare('SELECT day, key, n FROM funnel WHERE day >= ? ORDER BY day').bind(since).all();
    const days = {};
    const blank = () => ({ land: 0, try: 0, signup: 0, trial: 0, paid: 0, refs: {}, referers: {}, mcp: { initialize: {}, tools_list: {}, tools_call: {} }, tools: {}, self: { land: 0, try: 0 } });
    for (const { day, key, n } of results) {
      const d = days[day] ||= blank();
      const [kind, ...rest] = key.split(':'); const name = rest.join(':');
      if (!name && kind in d && typeof d[kind] === 'number') d[kind] += n;
      else if (kind === 'ref') d.refs[name] = n;
      else if (kind === 'referer') d.referers[name] = n;
      else if (kind === 'mcp_init') d.mcp.initialize[name] = n;
      else if (kind === 'mcp_list') d.mcp.tools_list[name] = n;
      else if (kind === 'mcp_call') d.mcp.tools_call[name] = n;
      else if (kind === 'tool') d.tools[name] = n;
      else if (kind === 'self' && name in d.self) d.self[name] = n;
    }
    const top = o => {
      const sorted = Object.entries(o).sort((a, b) => b[1] - a[1]);
      const kept = Object.fromEntries(sorted.slice(0, TOP));
      const rest = sorted.slice(TOP).reduce((s, [, n]) => s + n, 0);
      if (rest) kept.other = (kept.other || 0) + rest;
      return kept;
    };
    for (const d of Object.values(days)) {
      d.refs = top(d.refs); d.referers = top(d.referers); d.tools = top(d.tools);
      for (const k of Object.keys(d.mcp)) d.mcp[k] = top(d.mcp[k]);
    }
    return { product: 'pactwire', note: 'Aggregate counts per UTC day. No personal data is stored. "self" is our own scheduled live check.', days };
  }
  return { count, read };
}
