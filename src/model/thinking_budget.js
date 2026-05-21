// SmallCode — Thinking Budget Control
//
// Modern reasoning models (Qwen3, DeepSeek R1, GPT-5 reasoning, Claude with
// thinking) emit "thinking" tokens before their final answer. These tokens
// are wrapped in `<think>...</think>`, `<reasoning>...</reasoning>`, or
// embedded in a separate field depending on the provider.
//
// Without a budget, a small reasoning model can spend 8000 tokens "thinking"
// about a trivial rename, blowing through context and adding minutes of
// latency. This module provides:
//
//   - `applyThinkingBudget(body, budget)` — mutates the request body to
//     advise the provider on a thinking-token cap. Different providers use
//     different field names; we set them all defensively.
//
//   - `extractThinking(content)` — splits a response into { thinking, answer }
//     so we can show the answer to the model's next turn while logging the
//     thinking separately.
//
//   - `truncateThinking(content, maxThinkingChars)` — emergency cap: if the
//     model emitted way more thinking than budgeted, replace the middle of
//     the thinking block with [...truncated...] before adding to history.
//
// Configuration:
//   SMALLCODE_THINKING_BUDGET=2000    Soft cap (tokens) advised to the model
//   SMALLCODE_THINKING_DISABLE=true   Disable thinking entirely (for repair)
//   SMALLCODE_THINKING_HARD_CAP=8000  Hard cap (chars) — emergency truncation

'use strict';

const DEFAULT_BUDGET_TOKENS = parseInt(process.env.SMALLCODE_THINKING_BUDGET) || 2000;
const HARD_CAP_CHARS = parseInt(process.env.SMALLCODE_THINKING_HARD_CAP) || 32000;

// Patterns for detecting and stripping thinking blocks from model output.
// Models use various conventions — we handle the common ones.
const THINK_PATTERNS = [
  /<think>([\s\S]*?)<\/think>/g,
  /<thinking>([\s\S]*?)<\/thinking>/g,
  /<reasoning>([\s\S]*?)<\/reasoning>/g,
  /<reflection>([\s\S]*?)<\/reflection>/g,
];

/**
 * Apply thinking budget to a chat completion request body.
 * Mutates the body and returns it. Different providers honour different fields;
 * we set them all defensively. Providers that don't recognize a field ignore it.
 *
 * @param {object} body - The request body about to be sent
 * @param {object} options
 * @param {number} options.tokens - Token budget for thinking (0 = disabled)
 * @param {boolean} options.disable - Disable thinking entirely
 */
function applyThinkingBudget(body, options = {}) {
  // Don't mutate the caller's options — copy so SMALLCODE_THINKING_DISABLE env
  // override doesn't leak back into their object.
  const opts = { ...options };
  const tokens = opts.disable
    ? 0
    : (typeof opts.tokens === 'number' ? opts.tokens : DEFAULT_BUDGET_TOKENS);

  if (process.env.SMALLCODE_THINKING_DISABLE === 'true') {
    opts.disable = true;
  }

  // Anthropic-style: { thinking: { type: "enabled", budget_tokens: N } }
  // Set type:"disabled" to turn off, otherwise set the budget.
  body.thinking = opts.disable
    ? { type: 'disabled' }
    : { type: 'enabled', budget_tokens: Math.max(0, tokens) };

  // OpenAI o1/o3-style: reasoning_effort field with low/medium/high
  // Map our token budget to this enum.
  if (!opts.disable) {
    if (tokens <= 500) body.reasoning_effort = 'low';
    else if (tokens <= 3000) body.reasoning_effort = 'medium';
    else body.reasoning_effort = 'high';
  } else {
    body.reasoning_effort = 'low';
  }

  // Qwen-style chat_template_kwargs: { enable_thinking: bool }
  // Some Qwen3 builds expect this in a special field.
  body.chat_template_kwargs = body.chat_template_kwargs || {};
  body.chat_template_kwargs.enable_thinking = !opts.disable;
  if (!opts.disable) {
    body.chat_template_kwargs.thinking_budget = tokens;
  }

  // DeepSeek/llama.cpp-style: a top-level enable_thinking flag.
  // NOTE: setting both top-level + chat_template_kwargs is fine — providers
  // either honour their own field and ignore the other, or accept whichever
  // is present. We've seen no providers that conflict on these two.
  body.enable_thinking = !opts.disable;

  return body;
}

/**
 * Extract thinking from a model response. Returns { thinking, answer }.
 * If no thinking tags found, returns { thinking: '', answer: content }.
 */
function extractThinking(content) {
  if (typeof content !== 'string') return { thinking: '', answer: content };
  let thinking = '';
  let answer = content;
  for (const pattern of THINK_PATTERNS) {
    answer = answer.replace(pattern, (_match, inner) => {
      thinking += inner + '\n';
      return ''; // strip the thinking block from the answer
    });
  }
  return { thinking: thinking.trim(), answer: answer.trim() };
}

/**
 * Hard-cap thinking content — if the model ignored the soft budget and emitted
 * way too many thinking tokens, replace the middle of the thinking block with
 * an ellipsis marker. Keeps the start and end so we can debug what it was
 * trying to do without storing 50KB of "let me reconsider" loops.
 *
 * Returns the modified content (with thinking blocks truncated in place).
 */
function truncateThinking(content, maxChars = HARD_CAP_CHARS) {
  if (typeof content !== 'string' || content.length === 0) return content;
  let out = content;
  for (const pattern of THINK_PATTERNS) {
    out = out.replace(pattern, (match, inner) => {
      if (inner.length <= maxChars) return match;
      // Keep first 40% + last 20% of the thinking, ellipsize the middle
      const headLen = Math.floor(maxChars * 0.6);
      const tailLen = Math.floor(maxChars * 0.3);
      const head = inner.slice(0, headLen);
      const tail = inner.slice(inner.length - tailLen);
      const truncatedBytes = inner.length - headLen - tailLen;
      // Re-wrap with the same outer tags as the matched block
      const tagMatch = match.match(/^<(\w+)>/);
      const tag = tagMatch ? tagMatch[1] : 'think';
      return `<${tag}>${head}\n\n[...thinking truncated: ${truncatedBytes} chars omitted...]\n\n${tail}</${tag}>`;
    });
  }
  return out;
}

/**
 * Decide whether thinking should be disabled for a particular call.
 * Used by the improvement loop: after a failed attempt, the repair call
 * benefits from disabling thinking entirely — the model already overthought
 * the first time, we want a fast, deterministic fix.
 *
 * @param {object} ctx - { isRepair: bool, attempt: number, budget: number }
 */
function shouldDisableThinking(ctx = {}) {
  if (process.env.SMALLCODE_THINKING_DISABLE === 'true') return true;
  // On repair attempts (attempt > 1), disable thinking — the model already
  // overthought the original solution. A fast, low-creativity retry is better.
  if (ctx.isRepair && ctx.attempt > 1) return true;
  // Budget of 0 = explicit disable
  if (typeof ctx.budget === 'number' && ctx.budget === 0) return true;
  return false;
}

/**
 * Estimate how many tokens were spent on thinking in a response.
 * Useful for logging and budget tracking. Returns 0 if no thinking found.
 */
function estimateThinkingTokens(content) {
  if (typeof content !== 'string') return 0;
  let totalChars = 0;
  for (const pattern of THINK_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      for (const m of matches) totalChars += m.length;
    }
  }
  // Rough: 4 chars per token
  return Math.ceil(totalChars / 4);
}

module.exports = {
  applyThinkingBudget,
  extractThinking,
  truncateThinking,
  shouldDisableThinking,
  estimateThinkingTokens,
  DEFAULT_BUDGET_TOKENS,
  HARD_CAP_CHARS,
};
