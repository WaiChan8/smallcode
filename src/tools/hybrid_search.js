// SmallCode — Hybrid Code Search ("grep on steroids")
//
// Realizes the ideas from issue #67: a single search call that fuses
//   1. EXACT matching   — regex / keyword (the precision of grep)
//   2. SEMANTIC ranking  — meaning-based similarity (find code that *does* a
//                          thing even when it doesn't contain the query words)
// over a symbol-aware (AST-ish) chunk index kept in a small local file.
//
// The referenced projects (colgrep = Rust + ColBERT multi-vector, semble =
// Python + model2vec) are excellent but pull in heavy native/Python runtimes
// and model downloads. SmallCode's whole premise is staying small and fully
// local with zero external services, so this reuses the existing local hybrid
// scoring engine (BM25 + hashed bag-of-words vectors from src/rag/index_store)
// rather than shipping an embedding model. Same single-call hybrid ergonomics,
// no new dependencies, no model weights, runs instantly on CPU.
//
// If a semantic embedding MCP (e.g. budget-aware-mcp) is connected, callers can
// still layer it on top; this tool guarantees a useful local baseline offline.
//
// Configuration:
//   SMALLCODE_HYBRID_MAX_FILES   max files to index per search (default 1500)
//   SMALLCODE_HYBRID_MAX_BYTES   skip files larger than this (default 524288)

'use strict';

const fs = require('fs');
const path = require('path');
const { tokenize, embed, cosine, bm25Score } = require('../rag/index_store');
const { SOURCE_EXTS, SKIP_DIRS } = require('./file_tree');

const MAX_FILES = parseInt(process.env.SMALLCODE_HYBRID_MAX_FILES, 10) || 1500;
const MAX_BYTES = parseInt(process.env.SMALLCODE_HYBRID_MAX_BYTES, 10) || 512 * 1024;

// Symbol-definition patterns across common languages. We don't build a full
// AST — we detect definition boundaries so each chunk is centered on a
// function/class/method, which is what makes semantic ranking meaningful.
const SYMBOL_PATTERNS = [
  /\b(?:function|func|fn|def|sub)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:class|struct|interface|enum|trait|impl|type)\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/,
  /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,            // method(...) {
  /(?:public|private|protected|static|async)\s+([A-Za-z_$][\w$]*)\s*\(/,
];

function detectSymbol(line) {
  for (const re of SYMBOL_PATTERNS) {
    const m = line.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Walk the tree collecting source files, honoring the shared ignore list.
function collectFiles(root, limit = MAX_FILES) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= limit) break;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

// Split a file into symbol-centered chunks. A new chunk starts at each detected
// definition; lines before the first definition form a leading chunk. This
// keeps chunks semantically coherent without a real parser.
function chunkFile(relPath, content) {
  const lines = content.split('\n');
  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.lines.join('\n').trim()) {
      chunks.push({
        id: `${relPath}:${cur.startLine}`,
        path: relPath,
        startLine: cur.startLine,
        endLine: cur.startLine + cur.lines.length - 1,
        symbol: cur.symbol || '',
        code: cur.lines.join('\n'),
      });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const sym = detectSymbol(lines[i]);
    if (sym || cur === null) {
      // Boundary: close the previous chunk and open a new one. Avoid making a
      // brand-new chunk for back-to-back definition lines with no body yet.
      if (cur && (sym ? cur.lines.length > 1 : true)) flush();
      if (!cur || sym) cur = { startLine: i + 1, symbol: sym, lines: [] };
    }
    cur.lines.push(lines[i]);
    // Cap runaway chunks so a file with no detected symbols still splits.
    if (cur.lines.length >= 80) { flush(); cur = { startLine: i + 2, symbol: '', lines: [] }; }
  }
  flush();
  return chunks;
}

// Build an in-memory hybrid index over the project's source chunks.
function buildIndex(root, opts = {}) {
  const files = collectFiles(root, opts.maxFiles || MAX_FILES);
  const docs = [];
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size > (opts.maxBytes || MAX_BYTES)) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (content.includes('\u0000')) continue; // binary
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const chunk of chunkFile(rel, content)) {
      const searchable = [chunk.path, chunk.symbol, chunk.code].filter(Boolean).join('\n');
      const tokens = tokenize(searchable);
      const tf = Object.create(null);
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      docs.push({ ...chunk, termFreq: tf, docLength: tokens.length, embedding: embed(searchable) });
    }
  }
  return docs;
}

// Compile the user pattern into a regex. `keyword` mode escapes regex
// metacharacters so the query is treated literally.
function compilePattern(query, mode) {
  if (mode === 'semantic') return null;
  const flags = 'i';
  if (mode === 'keyword') {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, flags);
  }
  try { return new RegExp(query, flags); }
  catch { // invalid regex → fall back to literal keyword match
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

function _stats(docs, queryTerms) {
  const df = new Map(queryTerms.map(t => [t, 0]));
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.docLength || 0;
    for (const t of queryTerms) if (d.termFreq[t]) df.set(t, df.get(t) + 1);
  }
  return { df, totalDocs: docs.length || 1, avgDocLength: totalLen / (docs.length || 1) || 1 };
}

/**
 * Hybrid search over a project directory.
 *
 * @param {string} query
 * @param {object} options
 *   - root:   project root (default cwd)
 *   - mode:   'hybrid' (default) | 'regex' | 'keyword' | 'semantic'
 *   - limit:  max results (default 10)
 *   - vectorWeight: semantic weight in fusion (default 0.6)
 *   - exactBoost: score bonus when a chunk also matches exactly (default 2.0)
 * @returns {Array<{path,startLine,endLine,symbol,score,exact,snippet}>}
 */
function hybridSearch(query, options = {}) {
  const root = options.root || process.cwd();
  const mode = options.mode || 'hybrid';
  const limit = options.limit || 10;
  const vectorWeight = options.vectorWeight ?? 0.6;
  const exactBoost = options.exactBoost ?? 2.0;

  const docs = options._index || buildIndex(root, options);
  if (!docs.length) return [];

  const regex = compilePattern(query, mode);
  const queryTerms = [...new Set(tokenize(query))];
  const queryEmbedding = embed(query);
  const stats = _stats(docs, queryTerms);

  const scored = [];
  for (const d of docs) {
    let exact = false;
    let exactHits = 0;
    if (regex) {
      const m = d.code.match(new RegExp(regex.source, 'gi'));
      if (m) { exact = true; exactHits = m.length; }
    }
    // 'regex'/'keyword' are exact-only: drop non-matching chunks entirely.
    if ((mode === 'regex' || mode === 'keyword') && !exact) continue;

    const bm25 = bm25Score(queryTerms, d, stats);
    const vector = cosine(queryEmbedding, d.embedding || {});
    let score = bm25 + vectorWeight * vector;
    if (mode === 'semantic') score = vector;
    if (exact) score += exactBoost + Math.min(exactHits, 5) * 0.2;

    if (score <= 0) continue;
    scored.push({
      path: d.path,
      startLine: d.startLine,
      endLine: d.endLine,
      symbol: d.symbol,
      score: Number(score.toFixed(4)),
      exact,
      snippet: _firstMatchSnippet(d, regex),
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Pull the most relevant 1-3 lines for display: the first exact match line if
// any, otherwise the symbol/signature line.
function _firstMatchSnippet(doc, regex) {
  const lines = doc.code.split('\n');
  if (regex) {
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        return lines[i].trim().slice(0, 160);
      }
    }
  }
  return (lines.find(l => l.trim()) || '').trim().slice(0, 160);
}

// Format results as a compact, model-friendly block.
function formatResults(results, query, mode) {
  if (!results.length) return `No results for "${query}" (mode: ${mode}).`;
  const lines = [`Hybrid search: "${query}" (mode: ${mode}) — ${results.length} result(s)`, ''];
  for (const r of results) {
    const loc = `${r.path}:${r.startLine}`;
    const sym = r.symbol ? ` ${r.symbol}` : '';
    const tag = r.exact ? '●' : '○'; // ● exact+semantic, ○ semantic-only
    lines.push(`${tag} ${loc}${sym}  [score ${r.score}]`);
    if (r.snippet) lines.push(`    ${r.snippet}`);
  }
  lines.push('');
  lines.push('● exact + semantic match   ○ semantic match only');
  return lines.join('\n');
}

module.exports = {
  hybridSearch,
  buildIndex,
  chunkFile,
  detectSymbol,
  compilePattern,
  formatResults,
};
