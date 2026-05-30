// SmallCode — Message Normalizer
//
// Some chat templates (notably Qwen3 / Qwen3.5 under llama.cpp with --jinja)
// enforce that a `system` role message may only appear at index 0 of the
// messages array. Their Jinja template raises:
//
//   raise_exception('System message must be at the beginning.')
//
// …and llama.cpp returns HTTP 400 BEFORE the request is processed — but only
// when `tools` are present, because that's when it compiles the template to
// build a tool-call grammar. (See issue #62.)
//
// SmallCode legitimately injects system-role content mid-conversation in
// several places: clarification instructions, plan requests, planner
// injection, path-validation warnings, skill activation, and compaction
// summaries. Each of those pushes a `{ role: 'system', content }` object into
// the live conversation history, so by the time we assemble the request the
// array can look like:
//
//   [system(prompt), user, assistant, system(plan), user, system(warning), ...]
//
// This module collapses any such array into a single leading system message
// followed by only non-system turns — satisfying strict templates while
// preserving the injected instructions (they're merged into the lead system
// message, not dropped).
//
// Design notes:
//   - Order is preserved: stray system messages are appended to the lead
//     system content in the order they appeared, so later instructions still
//     come after earlier ones.
//   - Non-string content (multimodal image arrays on user turns) is never
//     touched — only `role: 'system'` entries are merged, and those are
//     always plain strings in this codebase.
//   - Idempotent: running it on an already-normalized array is a no-op.

'use strict';

/**
 * Collapse all system-role messages into a single leading system message.
 *
 * @param {Array<{role:string, content:any}>} messages  OpenAI-style messages.
 * @returns {Array} A new array with exactly one system message at index 0
 *   (when any system content exists), followed by all non-system messages in
 *   their original order. The input array is not mutated.
 */
function consolidateSystemMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const systemParts = [];
  const rest = [];

  for (const msg of messages) {
    if (msg && msg.role === 'system' && typeof msg.content === 'string') {
      const trimmed = msg.content.trim();
      if (trimmed) systemParts.push(trimmed);
    } else {
      rest.push(msg);
    }
  }

  // No system content at all → return the non-system messages unchanged.
  if (systemParts.length === 0) return rest.length === messages.length ? messages : rest;

  // De-duplicate consecutive identical blocks (the same instruction can be
  // re-injected across turns; collapsing avoids ballooning the lead prompt).
  const deduped = [];
  for (const part of systemParts) {
    if (deduped[deduped.length - 1] !== part) deduped.push(part);
  }

  const merged = { role: 'system', content: deduped.join('\n\n') };
  return [merged, ...rest];
}

/**
 * Recover a final answer that a reasoning model placed in `reasoning_content`
 * while leaving `content` empty (issue #49). Some servers — vLLM with
 * `--reasoning-parser qwen3`, DeepSeek R1, and other reasoning models — emit
 * the model's final prose answer in the `reasoning_content` channel and leave
 * `content` empty when there is no tool call. The agent loop would otherwise
 * see an empty turn and exit with no output.
 *
 * Mutates `message` in place: when it has no tool calls, an empty `content`,
 * and a non-empty `reasoning_content`, the reasoning text is promoted to
 * `content`. Returns true if a promotion happened, false otherwise.
 *
 * @param {object} message  OpenAI-style assistant message.
 * @returns {boolean}
 */
function recoverReasoningAnswer(message) {
  if (!message || typeof message !== 'object') return false;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) return false;
  const contentEmpty = !(typeof message.content === 'string' && message.content.trim());
  if (!contentEmpty) return false;
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
  if (!reasoning) return false;
  message.content = reasoning;
  return true;
}

module.exports = { consolidateSystemMessages, recoverReasoningAnswer };
