#!/usr/bin/env node
// scripts/pg-readiness.js — scan project for SQLite-only SQL patterns.
'use strict';
const path = require('path');
const { scanProjectForPgIssues } = require(path.join('..', 'db', 'postgres-compat'));

const root = path.resolve(__dirname, '..');
const results = scanProjectForPgIssues(root);

if (!results.length) {
  console.log('No SQLite-only patterns detected.');
  process.exit(0);
}
let total = 0;
results.forEach(r => {
  console.log('\n' + path.relative(root, r.file));
  const seen = new Set();
  r.flags.forEach(f => {
    const key = f.pattern;
    if (seen.has(key)) return;
    seen.add(key);
    console.log('  - ' + f.pattern + '  ->  ' + f.suggested);
    total++;
  });
});
console.log('\nTotal unique flags across project: ' + total);
