// Acceptance checks: the rules both agents sign up front that decide whether
// delivered work is accepted (seller is paid) or rejected (buyer is refunded).
//
// Every built-in check is deterministic: the same output always gives the same
// verdict, no AI judges anything, and anyone can re-run the checks from the
// receipt. Checks that need the outside world (fetching a URL, asking an
// independent verifier agent) are explicit check types with their own evidence.

import { canonical, sha256Hex } from './crypto.mjs';

export const CHECK_TYPES = ['json_schema', 'field_equals', 'field_matches', 'contains_text', 'max_bytes', 'sha256', 'count_at_least',
  'number_between', 'word_count', 'date_between', 'unique_by', 'quotes_in_source', 'each', 'all_of', 'any_of', 'not',
  'url_content_hash', 'verifier_agent'];
// Checks that may appear inside each / all_of / any_of / not: only offline, deterministic ones.
const OFFLINE_TYPES = CHECK_TYPES.filter(t => t !== 'url_content_hash' && t !== 'verifier_agent');
const GROUP_TYPES = ['each', 'all_of', 'any_of', 'not'];
const MAX_DEPTH = 3;
const MAX_TOTAL_CHECKS = 60;
const MAX_CHECKS = 20;
const MAX_REGEX_INPUT = 20000;

export function getPath(value, path) {
  if (path === undefined || path === '' || path === '$') return value;
  const parts = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  let cur = value;
  for (const raw of parts) {
    if (cur === null || cur === undefined) return undefined;
    const key = raw.startsWith('[') ? Number(raw.slice(1, -1)) : raw;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    cur = Object.prototype.hasOwnProperty.call(Object(cur), key) ? cur[key] : undefined;
  }
  return cur;
}

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** A small JSON Schema validator (the commonly used subset of draft 2020-12). */
export function validateSchema(schema, value, at = '$', errors = []) {
  if (errors.length > 20) return errors;
  if (schema === true || schema === undefined) return errors;
  if (schema === false) { errors.push(`${at}: not allowed`); return errors; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) { errors.push(`${at}: expected ${types.join('|')}, got ${t}`); return errors; }
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(e => canonical(e) === canonical(value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !safeRegex(schema.pattern).test(value.slice(0, MAX_REGEX_INPUT))) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === 'uri' && !/^https?:\/\/[^\s]+$/i.test(value)) errors.push(`${at}: not a URL`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validateSchema(schema.items, v, `${at}[${i}]`, errors));
    if (schema.uniqueItems && new Set(value.map(v => canonical(v))).size !== value.length) errors.push(`${at}: items not unique`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(`${at}: missing ${k}`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (Object.prototype.hasOwnProperty.call(value, k)) validateSchema(s, value[k], `${at}.${k}`, errors);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(schema.properties || {})[k]) errors.push(`${at}: unexpected property ${k}`);
  }
  for (const sub of schema.allOf || []) validateSchema(sub, value, at, errors);
  if (schema.anyOf && !schema.anyOf.some(sub => validateSchema(sub, value, at, []).length === 0)) errors.push(`${at}: matches none of anyOf`);
  return errors;
}

function safeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) throw new CheckDefinitionError('pattern must be a string of at most 200 characters');
  // Reject nested quantifiers, the usual cause of catastrophic backtracking.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new CheckDefinitionError('pattern has nested quantifiers');
  try { return new RegExp(pattern, 'u'); } catch { throw new CheckDefinitionError('pattern is not a valid regular expression'); }
}

export class CheckDefinitionError extends Error {}

/** Validate check definitions when a deal is proposed, so bad rules fail early. */
export function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) throw new CheckDefinitionError('acceptance must be a non-empty array of checks');
  if (checks.length > MAX_CHECKS) throw new CheckDefinitionError(`at most ${MAX_CHECKS} checks`);
  const counter = { n: 0 };
  for (const c of checks) validateOne(c, CHECK_TYPES, 0, counter);
  return checks;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
function validateOne(c, allowed, depth, counter) {
  if (++counter.n > MAX_TOTAL_CHECKS) throw new CheckDefinitionError(`at most ${MAX_TOTAL_CHECKS} checks in total, counting nested ones`);
  if (!c || !CHECK_TYPES.includes(c.type)) throw new CheckDefinitionError(`unknown check type ${c?.type}; use one of ${CHECK_TYPES.join(', ')}`);
  if (!allowed.includes(c.type)) throw new CheckDefinitionError(`${c.type} cannot be used inside each, all_of, any_of or not`);
  if (c.type === 'json_schema' && (typeof c.schema !== 'object' || c.schema === null)) throw new CheckDefinitionError('json_schema needs a schema object');
  if (c.type === 'json_schema' && canonical(c.schema).length > 16000) throw new CheckDefinitionError('json_schema is limited to 16000 characters');
  if (c.type === 'field_matches') safeRegex(c.pattern);
  if (c.type === 'json_schema') JSON.stringify(c.schema, (k, v) => { if (k === 'pattern') safeRegex(v); return v; });
  if (c.type === 'contains_text' && (typeof c.text !== 'string' || !c.text)) throw new CheckDefinitionError('contains_text needs text');
  if (c.type === 'max_bytes' && !(Number.isInteger(c.bytes) && c.bytes > 0)) throw new CheckDefinitionError('max_bytes needs a positive integer bytes');
  if (c.type === 'sha256' && !/^[0-9a-f]{64}$/.test(c.equals || '')) throw new CheckDefinitionError('sha256 needs equals: a 64-character hex digest');
  if (c.type === 'count_at_least' && !(Number.isInteger(c.min) && c.min >= 0)) throw new CheckDefinitionError('count_at_least needs min');
  if ((c.type === 'number_between' || c.type === 'word_count') && ((c.min !== undefined && !isNum(c.min)) || (c.max !== undefined && !isNum(c.max)) || (c.min === undefined && c.max === undefined)))
    throw new CheckDefinitionError(`${c.type} needs min and/or max as numbers`);
  if (c.type === 'date_between' && ((c.after !== undefined && Number.isNaN(Date.parse(c.after))) || (c.before !== undefined && Number.isNaN(Date.parse(c.before))) || (c.after === undefined && c.before === undefined)))
    throw new CheckDefinitionError('date_between needs after and/or before as ISO 8601 dates');
  if (c.type === 'unique_by' && (typeof c.path !== 'string' || (c.key !== undefined && typeof c.key !== 'string'))) throw new CheckDefinitionError('unique_by needs path (an array) and optional key');
  if (c.type === 'quotes_in_source' && (typeof c.path !== 'string' || (typeof c.source !== 'string' && typeof c.sourceTaskPath !== 'string')))
    throw new CheckDefinitionError('quotes_in_source needs path, plus source (text) or sourceTaskPath (where the source is in the task)');
  if (c.type === 'quotes_in_source' && c.minWords !== undefined && !(Number.isInteger(c.minWords) && c.minWords >= 1)) throw new CheckDefinitionError('quotes_in_source minWords must be a whole number of at least 1');
  if (c.type === 'quotes_in_source' && typeof c.source === 'string' && c.source.length > 100000) throw new CheckDefinitionError('quotes_in_source source is limited to 100000 characters');
  if (c.type === 'url_content_hash' && (!c.urlPath || !c.hashPath)) throw new CheckDefinitionError('url_content_hash needs urlPath and hashPath');
  if (c.type === 'verifier_agent' && !/^https?:\/\//.test(c.agent || '')) throw new CheckDefinitionError('verifier_agent needs agent: the verifier agent origin URL');
  if (GROUP_TYPES.includes(c.type)) {
    if (depth + 1 > MAX_DEPTH) throw new CheckDefinitionError(`checks can be nested at most ${MAX_DEPTH} deep`);
    if (c.type === 'not') { if (!c.check || typeof c.check !== 'object') throw new CheckDefinitionError('not needs check: one check'); validateOne(c.check, OFFLINE_TYPES, depth + 1, counter); return; }
    if (!Array.isArray(c.checks) || c.checks.length === 0) throw new CheckDefinitionError(`${c.type} needs checks: a non-empty list`);
    if (c.type === 'each' && typeof c.path !== 'string') throw new CheckDefinitionError('each needs path: the array whose items are checked');
    if (c.type === 'each' && c.minItems !== undefined && !(Number.isInteger(c.minItems) && c.minItems >= 0)) throw new CheckDefinitionError('each minItems must be a whole number');
    for (const sub of c.checks) validateOne(sub, OFFLINE_TYPES, depth + 1, counter);
  }
}

// Quote marks are ignored, so a quote that wraps a word in quotes still matches the source.
const norm = s => String(s).normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/["\u201C\u201D]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const words = s => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const MAX_EACH_ITEMS = 1000;

/** Run one offline (deterministic) check. Returns { pass, detail }. */
async function runOffline(c, output, ctx) {
  switch (c.type) {
    case 'json_schema': { const errs = validateSchema(c.schema, getPath(output, c.path)); return { pass: errs.length === 0, detail: errs.length ? errs.slice(0, 5).join('; ') : 'schema ok' }; }
    case 'field_equals': { const v = getPath(output, c.path); const pass = canonical(v ?? null) === canonical(c.value ?? null); return { pass, detail: pass ? `${c.path} equals the agreed value` : `${c.path} differs from the agreed value` }; }
    case 'field_matches': { const v = getPath(output, c.path); const pass = typeof v === 'string' && safeRegex(c.pattern).test(v.slice(0, MAX_REGEX_INPUT)); return { pass, detail: pass ? `${c.path} matches` : `${c.path} does not match` }; }
    case 'contains_text': {
      const v = getPath(output, c.path); const hay = typeof v === 'string' ? v : canonical(v ?? null);
      const pass = c.caseSensitive ? hay.includes(c.text) : hay.toLowerCase().includes(c.text.toLowerCase());
      return { pass, detail: pass ? 'text found' : `text "${c.text.slice(0, 40)}" not found` };
    }
    case 'max_bytes': { const n = new TextEncoder().encode(canonical(output)).byteLength; return { pass: n <= c.bytes, detail: `${n} bytes` }; }
    case 'sha256': { const v = getPath(output, c.path); const h = await sha256Hex(typeof v === 'string' ? v : canonical(v ?? null)); return { pass: h === c.equals, detail: h === c.equals ? 'hash matches' : `hash ${h.slice(0, 12)}…` }; }
    case 'count_at_least': { const v = getPath(output, c.path); return { pass: Array.isArray(v) && v.length >= c.min, detail: `${Array.isArray(v) ? v.length : 0} items` }; }
    case 'number_between': {
      const v = getPath(output, c.path);
      if (!isNum(v)) return { pass: false, detail: `${c.path ?? 'output'} is not a number` };
      const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
      return { pass, detail: `${v} ${pass ? 'is' : 'is not'} within ${c.min ?? '-∞'}..${c.max ?? '∞'}` };
    }
    case 'word_count': {
      const v = getPath(output, c.path);
      if (typeof v !== 'string') return { pass: false, detail: `${c.path ?? 'output'} is not text` };
      const n = words(v); const pass = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
      return { pass, detail: `${n} words` };
    }
    case 'date_between': {
      const v = getPath(output, c.path); const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN;
      if (Number.isNaN(t)) return { pass: false, detail: `${c.path ?? 'output'} is not an ISO 8601 date` };
      const pass = (c.after === undefined || t >= Date.parse(c.after)) && (c.before === undefined || t <= Date.parse(c.before));
      return { pass, detail: pass ? 'date in range' : `${v} is out of range` };
    }
    case 'unique_by': {
      const v = getPath(output, c.path);
      if (!Array.isArray(v)) return { pass: false, detail: `${c.path} is not a list` };
      const seen = new Set(); let dup = null;
      for (const item of v.slice(0, MAX_EACH_ITEMS)) { const k = canonical((c.key ? getPath(item, c.key) : item) ?? null); if (seen.has(k)) { dup = k; break; } seen.add(k); }
      return { pass: dup === null && v.length <= MAX_EACH_ITEMS, detail: dup === null ? `${v.length} unique` : `duplicate ${dup.slice(0, 60)}` };
    }
    case 'quotes_in_source': {
      // Every quoted string must appear in the source text (ignoring case, curly quotes and spacing).
      // This is the grounding rule: the seller may only state what the source says.
      const src = typeof c.source === 'string' ? c.source : getPath(ctx.task, c.sourceTaskPath);
      if (typeof src !== 'string' || !src) return { pass: false, detail: 'source text not found' };
      const v = getPath(output, c.path); const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
      if (!list || !list.length || list.some(x => typeof x !== 'string')) return { pass: false, detail: `${c.path} must be text or a list of text` };
      const hay = norm(src); const strip = q => norm(q).replace(/[.!?;:,]+$/, '');
      // Each quote must be a real claim (minWords, default 3), so quoting one common word cannot pass.
      const minW = c.minWords ?? 3;
      const missing = list.findIndex(q => words(q) < minW || !hay.includes(strip(q)));
      return { pass: missing < 0, detail: missing < 0 ? `all ${list.length} found in the source` : `item ${missing} is shorter than ${minW} words or is not in the source` };
    }
    case 'each': {
      const v = getPath(output, c.path);
      if (!Array.isArray(v)) return { pass: false, detail: `${c.path} is not a list` };
      if (v.length < (c.minItems ?? 1)) return { pass: false, detail: `${v.length} items, need at least ${c.minItems ?? 1}` };
      if (v.length > MAX_EACH_ITEMS) return { pass: false, detail: `more than ${MAX_EACH_ITEMS} items` };
      for (const [i, item] of v.entries()) for (const sub of c.checks) {
        const r = await safeOffline(sub, item, ctx); if (!r.pass) return { pass: false, detail: `item ${i}: ${sub.type}: ${r.detail}` };
      }
      return { pass: true, detail: `all ${v.length} items pass` };
    }
    case 'all_of': { for (const sub of c.checks) { const r = await safeOffline(sub, output, ctx); if (!r.pass) return { pass: false, detail: `${sub.type}: ${r.detail}` }; } return { pass: true, detail: 'all pass' }; }
    case 'any_of': { const ds = []; for (const sub of c.checks) { const r = await safeOffline(sub, output, ctx); if (r.pass) return { pass: true, detail: `${sub.type} passes` }; ds.push(r.detail); } return { pass: false, detail: `none pass (${ds.join('; ').slice(0, 160)})` }; }
    case 'not': { const r = await safeOffline(c.check, output, ctx); return { pass: !r.pass, detail: r.pass ? `${c.check.type} passes, so not fails` : `${c.check.type} fails, as required` }; }
  }
  return { pass: false, detail: `unknown check ${c.type}` };
}
async function safeOffline(c, output, ctx) {
  try { return await runOffline(c, output, ctx); } catch (e) { return { pass: false, detail: `check error: ${String(e?.message || e).slice(0, 160)}` }; }
}

/**
 * Run every check against the delivered output.
 * ctx.fetchUrl(url) -> { status, bytes } for url_content_hash (network, SSRF-guarded by the caller)
 * ctx.askVerifier(check, output) -> { pass, detail, attestation } for verifier_agent
 * ctx.task: the deal's task, for quotes_in_source with sourceTaskPath
 */
export async function runChecks(checks, output, ctx = {}) {
  const results = [];
  for (const [i, c] of checks.entries()) {
    let pass = false; let detail = '';
    try {
      switch (c.type) {
        default: ({ pass, detail } = await runOffline(c, output, ctx)); break;
        case 'url_content_hash': {
          const url = getPath(output, c.urlPath); const claimed = getPath(output, c.hashPath);
          if (typeof url !== 'string' || typeof claimed !== 'string') { detail = 'url or hash missing'; break; }
          if (!ctx.fetchUrl) { detail = 'url checks are not enabled on this server'; break; }
          let got; try { got = await ctx.fetchUrl(url); } catch { detail = 'content at the URL could not be fetched or does not hash to the claimed value'; break; }
          const h = await sha256Hex(got.bytes);
          pass = got.status >= 200 && got.status < 300 && h === claimed.toLowerCase();
          // Report only pass/fail: echoing status or content hashes would turn this check into a probe.
          detail = pass ? 'content at the URL hashes to the claimed value' : 'content at the URL could not be fetched or does not hash to the claimed value';
          break;
        }
        case 'verifier_agent': {
          if (!ctx.askVerifier) { detail = 'verifier agents are not enabled on this server'; break; }
          const r = await ctx.askVerifier(c, output); pass = r.pass === true; detail = r.detail || (pass ? 'verifier passed' : 'verifier failed');
          results.push({ index: i, type: c.type, pass, detail, attestation: r.attestation }); continue;
        }
      }
    } catch (e) { pass = false; detail = `check error: ${String(e?.message || e).slice(0, 160)}`; }
    results.push({ index: i, type: c.type, pass, detail });
  }
  return { pass: results.length > 0 && results.every(r => r.pass), results };
}
