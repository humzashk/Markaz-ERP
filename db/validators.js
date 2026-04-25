// db/validators.js — strict input validators (reject NaN/invalid).
'use strict';

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}
function int(v, fallback = 0) {
  const n = num(v, NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}
function posInt(v) {
  const n = int(v, 0);
  return n > 0 ? n : null;
}
function nonNegNum(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Accept YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss]
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  if (isNaN(d.getTime())) return null;
  return s.substring(0, 10);
}
function nonEmptyStr(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.substring(0, max);
}
function oneOf(v, choices, fallback = null) {
  return choices.indexOf(v) !== -1 ? v : fallback;
}
function username(v) {
  const s = nonEmptyStr(v, 64);
  if (!s) return null;
  // Lowercase canonical form for case-insensitive uniqueness
  return s.toLowerCase().replace(/\s+/g, '');
}
// Validate a transaction payload; throws Error with field name on first failure.
function requireFields(obj, spec) {
  const errs = [];
  for (const key of Object.keys(spec)) {
    const rule = spec[key];
    const val = obj[key];
    let ok = true;
    if (rule === 'posInt')      ok = posInt(val) !== null;
    else if (rule === 'nonNegNum') ok = nonNegNum(val) !== null;
    else if (rule === 'isoDate')   ok = isoDate(val) !== null;
    else if (rule === 'str')       ok = nonEmptyStr(val) !== null;
    if (!ok) errs.push(key);
  }
  if (errs.length) {
    const e = new Error('Validation failed: ' + errs.join(','));
    e.fields = errs;
    e.code = 'EVALIDATION';
    throw e;
  }
}

module.exports = { num, int, posInt, nonNegNum, isoDate, nonEmptyStr, oneOf, username, requireFields };
