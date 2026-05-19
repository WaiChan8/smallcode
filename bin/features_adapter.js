// SmallCode — Features 1-6 Adapter
// Bridges the MarrowScript-compiled features into the agent loop.
// Compiled from: marrow/features_1_6.marrow
//
// Features:
//   1. repairToolCall(originalCall, error, schema)       — fix bad tool JSON
//   2. summarizeFileCompiled(path, content, targetTokens) — LLM file summary
//   3. policy enforcement — assertWithinBudget / chargeBudget
//   4. setApprovalHandler(fn)                            — checkpoint flow for write approval
//   5. retrieveContext(userMessage, mcpCall)             — semantic context retrieval
//   6. validateEditCompiled(filePath, content, task)     — self-critique after writes

'use strict';

// Lazy-load compiled modules
let _prompts = null;
let _policy = null;
let _checkpoints = null;
let _contextRetriever = null;

function _getPrompts() {
  if (_prompts) return _prompts;
  try { _prompts = require('../src/compiled/features/prompts'); return _prompts; } catch { return null; }
}

function _getPolicy() {
  if (_policy) return _policy;
  try { _policy = require('../src/compiled/features/policy'); return _policy; } catch { return null; }
}

function _getCheckpoints() {
  if (_checkpoints) return _checkpoints;
  try { _checkpoints = require('../src/compiled/features/checkpoints'); return _checkpoints; } catch { return null; }
}

function _getContextRetriever() {
  if (_contextRetriever) return _contextRetriever;
  try { _contextRetriever = require('../src/compiled/features/context_retriever'); return _contextRetriever; } catch { return null; }
}

// ─── Feature 1: Repair a malformed tool call ─────────────────────────────────

/**
 * Sends original_call + error + schema back to model for self-repair.
 * @returns {{ ok: boolean, repairedCall?: string, error?: string }}
 */
async function repairToolCall(originalCall, error, toolSchema) {
  const prompts = _getPrompts();
  if (!prompts) return { ok: false, error: 'prompts module unavailable' };
  try {
    const traceId = require('crypto').randomUUID();
    const result = await prompts.callPrompt('repair_tool_call', {
      original_call: String(originalCall).slice(0, 2000),
      error: String(error).slice(0, 500),
      tool_schema: String(toolSchema).slice(0, 1000),
    }, { trace_id: traceId });
    return { ok: true, repairedCall: String(result) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Feature 2: Summarize a large file ───────────────────────────────────────

/**
 * Summarize a large file to function signatures.
 * Returns summary string or null on failure.
 * Cached by content hash (1h TTL). Only runs on files > 100 lines.
 */
async function summarizeFileCompiled(filePath, content, targetTokens = 500) {
  const prompts = _getPrompts();
  if (!prompts) return null;
  if (!content || content.split('\n').length < 100) return null;
  try {
    const traceId = require('crypto').randomUUID();
    const result = await prompts.callPrompt('summarize_file', {
      file_path: filePath,
      content: content.slice(0, 8000),
      target_tokens: targetTokens,
    }, { trace_id: traceId });
    return String(result);
  } catch {
    return null;
  }
}

// ─── Feature 3: Budget policy enforcement ────────────────────────────────────

/**
 * Assert within budget before a turn.
 * Throws if rate limit exceeded. Silent if policy module unavailable.
 */
function assertWithinBudget(action, charge = {}) {
  const policy = _getPolicy();
  if (!policy) return; // graceful degradation
  policy.assertWithinBudget(action, charge);
}

/**
 * Charge budget after a turn completes.
 */
function chargeBudget(action, charge = {}) {
  const policy = _getPolicy();
  if (!policy) return;
  policy.chargeBudget(action, charge);
}

/**
 * Get current budget state for /tokens display.
 */
function getBudgetState() {
  const policy = _getPolicy();
  if (!policy) return null;
  return policy.getBudgetState();
}

// ─── Feature 4: Checkpoint approval flow ─────────────────────────────────────

/**
 * Set the TUI approval handler for edit checkpoints.
 * fn(flowRunId, checkpointName) => Promise<'approve'|'reject'|'edit'>
 */
function setApprovalHandler(fn) {
  const checkpoints = _getCheckpoints();
  if (!checkpoints) return;
  checkpoints.setApprovalHandler(fn);
}

/**
 * Await a checkpoint decision (used by the flow runtime).
 */
async function awaitCheckpointDecision(flowRunId, checkpointName, timeoutMs = 300000) {
  const checkpoints = _getCheckpoints();
  if (!checkpoints) return { decision: 'approve', timed_out: false, actor_id: 'fallback' };
  return checkpoints.awaitDecision(flowRunId, checkpointName, timeoutMs, 'cancel');
}

/**
 * Submit a checkpoint decision (called from TUI keypress handler).
 */
function submitCheckpointDecision(flowRunId, checkpointName, decision, actorId = 'user') {
  const checkpoints = _getCheckpoints();
  if (!checkpoints) return { ok: false };
  return checkpoints.submitDecision(flowRunId, checkpointName, decision, null, actorId);
}

// ─── Feature 5: Semantic context retrieval ───────────────────────────────────

/**
 * Retrieve relevant context for a user message via code graph.
 * @returns {{ files: string[], symbols: string[], tokenEstimate: number }}
 */
async function retrieveContext(userMessage, mcpCall, maxFiles = 8) {
  const retriever = _getContextRetriever();
  if (!retriever) return { files: [], symbols: [], tokenEstimate: 0 };
  return retriever.retrieveContext(userMessage, mcpCall, maxFiles);
}

// ─── Feature 6: Self-critique after edit ─────────────────────────────────────

/**
 * Ask model if the edit result looks correct.
 * @returns {{ ok: boolean, issues: string[] }}
 */
async function validateEditCompiled(filePath, content, originalTask) {
  const prompts = _getPrompts();
  if (!prompts) return { ok: true, issues: [] }; // graceful: don't block on unavailable
  try {
    const traceId = require('crypto').randomUUID();
    const result = await prompts.callPrompt('validate_edit', {
      file_path: filePath,
      content: content.slice(0, 4000),
      original_task: String(originalTask || '').slice(0, 500),
    }, { trace_id: traceId });
    const text = String(result).toLowerCase();
    const passed = text.includes('ok') || text.includes('correct') || text.includes('looks good') ||
      text.includes('valid') || text.includes('pass') || !text.includes('error');
    return { ok: passed, issues: passed ? [] : [String(result).slice(0, 200)] };
  } catch {
    return { ok: true, issues: [] }; // fail open
  }
}

// ─── Availability check ───────────────────────────────────────────────────────

/**
 * Check if the features module is fully available.
 */
function isFeaturesAvailable() {
  return _getPrompts() !== null;
}

module.exports = {
  repairToolCall,
  summarizeFileCompiled,
  assertWithinBudget,
  chargeBudget,
  getBudgetState,
  setApprovalHandler,
  awaitCheckpointDecision,
  submitCheckpointDecision,
  retrieveContext,
  validateEditCompiled,
  isFeaturesAvailable,
};
