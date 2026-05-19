# Changelog

## [0.6.9] - 2026-05-20

### Added
- **Features 1-6 Adapter** — `bin/features_adapter.js` wires six MarrowScript-compiled features into the agent loop:
  - Feature 1: `repairToolCall` — LLM self-repair for malformed tool call JSON
  - Feature 2: `summarizeFileCompiled` — Cached LLM file summarization (files >100 lines, 1h TTL)
  - Feature 3: `assertWithinBudget` / `chargeBudget` / `getBudgetState` — In-memory rate-limiting (30 turns/min, 500k tokens/hr)
  - Feature 4: `setApprovalHandler` / `awaitCheckpointDecision` / `submitCheckpointDecision` — TUI checkpoint approval flow
  - Feature 5: `retrieveContext` — Zero-LLM semantic context retrieval via code-graph-mcp walk
  - Feature 6: `validateEditCompiled` — Self-critique after file writes
- **`src/compiled/features/prompts.js`** — Self-contained prompt runner using direct fetch (no full provider stack). Inline templates for `repair_tool_call`, `summarize_file`, `validate_edit`. In-memory SHA-256 cache.
- **`src/compiled/features/policy.js`** — In-memory budget policy (no DB). Sliding window rate limits per turn and per-hour token budget.
- **`src/compiled/features/checkpoints.js`** — In-memory checkpoint flow with TUI approval callback support.
- **`src/compiled/features/context_retriever.js`** — Keyword-based graph walk for semantic context retrieval.
- **`marrow/features_1_6.marrow`** — MarrowScript source declaration for all six features (staged to git).

## [0.6.9] - 2026-05-19

### Added
- **Feature 1: Tool Call Repair** — When the model produces malformed JSON args, the compiled `repair_tool_call` prompt self-repairs instead of silently failing. Sends original call + error + schema back for single-shot correction.
- **Feature 2: File Summarization** — Large files (>200 lines) are automatically summarized to function signatures + key logic via `summarize_file` prompt. 1h TTL cache keyed by content hash. Falls back to full content gracefully.
- **Feature 3: Policy Enforcement** — In-memory sliding window rate limiter: 30 turns/min, 500k tokens/hr. Compiled from `agent_limits` policy in `features_1_6.marrow`. Warns on limit, doesn't hard-block local use.
- **Feature 4: Checkpoint Flow** — `edit_with_approval` flow compiled from MarrowScript. In-memory await/submit system with timeout + auto-approval handler. TUI can hook `setApprovalHandler` for supervised mode.
- **Feature 5: Context Retrieval** — Before each turn, walks code graph from user message keywords (zero LLM calls). Auto-injects relevant file hints into the system prompt. Keyword extractor prefers CamelCase/PascalCase symbols.
- **Feature 6: Self-critique** — After `write_file`/`patch`, asks model "does this look correct?" via `validate_edit` prompt (10m cache). Fails open — never blocks on unavailable model.
- `bin/features_adapter.js` — Unified adapter exposing 11 functions for all 6 features
- `src/compiled/features/prompts.js` — Self-contained prompt runner (direct fetch, in-memory cache)
- `src/compiled/features/policy.js` — In-memory budget policy runtime
- `src/compiled/features/checkpoints.js` — Checkpoint flow runtime
- `src/compiled/features/context_retriever.js` — Keyword extraction + graph walk
- `marrow/features_1_6.marrow` — Source declaration for all 6 features
- `.test-workspace/test_features_1_6.js` — 46-test suite (all passing)

### Changed
- `bin/executor.js` — `read_file` now triggers `summarize_file` for files >200 lines (Feature 2)
- `bin/smallcode.js` — Wired all 6 features: tool repair on parse fail, context retrieval per turn, policy assert/charge, self-critique on writes, rate limit display
- `bin/commands.js` — `/tokens` now shows policy budget state (turns/min, tokens/hr)



### Added
- **Deterministic Tool Router** — Compiled from `marrow/tool_router.marrow` to `src/compiled/tool_router.js`. Classifies user messages into tool categories (read/write/search/run/plan/web/respond) using pure weighted regex — zero LLM calls, zero tokens, zero latency.
- **Per-turn tool filtering** — On each new turn, the router pre-classifies the intent and injects only the relevant tool subset. Saves 71–100% of tool schema tokens per call:
  - `read` → 301 tok (was 1764, -83%)
  - `write` → 334 tok (-81%)
  - `search` → 278 tok (-84%)
  - `run` → 260 tok (-85%)
  - `plan` → 516 tok (-71%)
  - `web` → 97 tok (-95%)
  - `respond` → 0 tok (-100%, no tools injected for pure answer questions)
- **Router confidence display** — Fullscreen TUI shows category + confidence% in the tool panel on each turn.
- **20/20 classification accuracy** on test suite covering shell commands, code edits, search, planning, web lookups, greetings, and debugging questions.

### Changed
- **`getAllTools()`** — Now accepts `currentToolCategory` from the compiled router. Falls back to two_stage_router or all-tools if router unavailable.
- **Tool category resets mid-turn** — After first tool call, tool list widens to full set (model may need different categories mid-turn).
- **`marrow/tool_router.marrow`** — Source declaration for the compiled classifier (gitignored but included in npm package).

## [0.6.7] - 2026-05-19

### Added
- **Token Monitor** — Real-time tracking of prompt/completion tokens per call and per turn. Exposes efficiency metrics (completion:prompt ratio), compaction counts, and eviction counts.
- **`/tokens` command** — Detailed token usage report showing totals, per-call averages, and efficiency.
- **`/budget` command** — Visual context window budget display with usage bar, compaction/eviction stats.
- **Trace Recorder** — Automatically records every agent turn: tool calls, model responses, token usage, validations. Persists to `.smallcode/traces/`.
- **`/trace` command** — List, show, and export execution traces. Supports `list`, `show <id>`, `test <id>`.
- **Trace-to-Test** (`/trace test <id>`) — Generates Jest-compatible test files from recorded traces, asserting file creation and command success.
- **Prompt Evaluation Runner** — Built-in evaluation suites for task classification accuracy, tool selection quality, and response quality.
- **`/eval` command** — Run evaluations in-TUI (`/eval classify_accuracy`, `/eval tool_selection`).
- **`--eval <suite>` flag** — Non-interactive evaluation mode for CI/automation.
- **Bounded Loop Adapter** — Wired MarrowScript-compiled loop runtime into improvement loop for bounded iteration with tracing. Falls back to simple counting when compiled runtime unavailable.
- **`--trace <ID>` flag** — Placeholder for trace replay (documented, future implementation).

### Changed
- **Improvement loop** now tracks validation failures in token monitor and uses bounded loop adapter for iteration control.
- **`/stats` command** now shows token usage summary inline.
- **`/help` command** updated with all new commands (`/tokens`, `/budget`, `/trace`, `/eval`).

### Internal
- `bin/trace_recorder.js` — 160 lines, trace recording + test generation
- `bin/eval_runner.js` — 150 lines, evaluation framework with 3 built-in suites
- `bin/token_monitor.js` — Enhanced with `_nextCallIsNewTurn` pattern for turn boundary detection
- `bin/loops_adapter.js` — Bridges compiled MarrowScript bounded loops into agent
- `bin/commands.js` — Now accepts `tokenMonitor` parameter; 5 new commands added

## [0.6.6] - 2026-05-19

### Fixed
- **Permanent hang after tool calls** — Root cause: `streamFinalResponse` was called after tool calls completed, causing infinite await. Now only streams when `toolCallsThisTurn === 0`. Added 30s timeout as safety net.
- **120s abort timeout** on `chatCompletion` — Prevents permanent hang if model stops responding entirely.

## [0.6.1] - 2026-05-19

### Added
- **MarrowScript Cognition Layer** — Compiled from `marrow/smallcode_cognition.marrow`, generates 1400+ lines of production TypeScript runtime with:
  - Typed prompt callers with retry, timeout, and repair loops
  - Content-hash prompt caching (0ms on cache hit, 10m TTL)
  - Structured trace spans with trace_id/span_id for every LLM call
  - Token budget enforcement per cost class
  - Deterministic tier-based routing (trivial → simple → complex)
  - SSRF guard on all outbound requests
  - Schema validation with repair prompts on failure
- **Phase A: Compiled Task Classifier** — `classifyTask` now uses LLM-backed classification with cache, falling back to regex. Replaces hand-rolled regex-only approach.
- **Phase B: Compiled History Compression** — Semantic summarization of old messages before eviction. Preserves key facts instead of just dropping context.
- **Phase C: Compiled Tier Router** — `coding_router` dispatches to TinyClassifier/SmallCoder/MediumCoder based on complexity score.
- **`/cognition` command** — Shows live status of the MarrowScript cognition layer (loaded models, prompts, routers).
- **Blocking command detection** — Refuses to execute server-start commands (`node server.js`, `npm start`, etc.) that would hang the bash tool for 30s.
- **Mid-turn context eviction** — Every 3 tool calls, checks if history exceeds 60% of context budget and evicts old tool results.
- **19-test stress suite** — Covers file ops, multi-step tasks, code intelligence, improvement loop, error recovery, and governor routing.

### Fixed
- **Context overflow on tool-heavy tasks** — Tool results now capped at 4k chars each (was 12k). Prevents context explosion after 5+ tool calls.
- **Fullscreen response not rendering** — After tool calls, the model's final text response now properly renders via `addChat` instead of swallowed `stdout.write`.
- **Double output in fullscreen TUI** — Removed redundant `addChat` in `onSubmit` handler.
- **Mouse scroll + copy/paste** — Enabled mouse tracking for scroll wheel; `Shift+drag` selects text (shown in status bar).
- **"fetch failed" after bash timeout** — Blocking server commands now refused instead of timing out and corrupting the session.
- **File not found errors** — Path normalization strips `./` prefix, error shows resolved path for model self-correction.
- **list_projects output bloat** — Compacted to one line per project (was 6 lines each).

### Changed
- **Modular architecture complete** — `bin/smallcode.js` split from 2181 → 1570 lines across:
  - `bin/config.js` (165 lines) — Config + endpoint check
  - `bin/mcp_bridge.js` (151 lines) — Code graph MCP
  - `bin/executor.js` (338 lines) — Tool execution
  - `bin/model_client.js` (284 lines) — LLM communication
  - `bin/tools.js` (64 lines) — Tool definitions + routing
  - `bin/cognition_adapter.js` (100 lines) — Bridge to compiled cognition
- **System prompt 90% smaller** — Task-aware compact prompt (~200 tokens) replaces verbose 2k-token version.
- **Default context window** — 128k (was 0/auto-detect that often failed).
- **Cognition logs silent by default** — Set `SMALLCODE_COGNITION_LOG=stderr` to enable structured trace output.

## [0.5.0] - 2026-05-18

### Added
- **Programmatic API** — `const { SmallCode } = require('smallcode')`. Run prompts, subscribe to events, get structured results.
- **MCP Client** — Consume external MCP servers as tool providers. Configure in `.smallcode/mcp.json`.
- **Early-Stop Detection** — Catches repetition loops, patch spirals, and greeting regression automatically.
- **2-Stage Tool Router** — Reduces schema context by ~50% for small-context models (≤16k).
- **Model Profiles** — Auto-detects Gemma/Qwen/DeepSeek/Llama capabilities from model name.
- **`-P` / `--prompt` flag** — Run a single prompt: `smallcode -P "fix the bug"`.
- **`/profile` command** — Shows detected model profile and routing mode.
- **`/mcp` command** — Shows connected external MCP servers.
- **E2E Test Suite** — 10 tests covering math, file ops, patching, search, graph, and architecture prompts.

### Fixed
- **Auth headers in all API paths** — chatCompletion, streamFinalResponse, sendToModel, and startup health check all send `Authorization: Bearer` when API key is configured.
- **OpenRouter support** — Required `HTTP-Referer` and `X-Title` headers added automatically.
- **`/escalation` command crash** — `escalationEngine` was out of scope in command handler.
- **`-v` flag collision** — `-v` is version, `-V` is verbose.
- **VERSION constant** — Aligned across all files.
- **Auto-compact preserves system messages** — Skills and plugin injections no longer evicted.
- **"Exit code undefined"** — Properly reports timeout instead of undefined.
- **Native deps optional** — `better-sqlite3` moved to optionalDependencies. Install no longer needs C++ build tools.
- **Patch spiral recovery** — After 4 failed patches, forces `write_file` rewrite instead of infinite loop.
- **Streaming repetition detection** — Halts generation when model repeats itself.

### Changed
- **Modular architecture** — Monolithic `bin/smallcode.js` (2181 lines) split into focused modules:
  - `bin/config.js` (165 lines) — Config + endpoint detection
  - `bin/mcp_bridge.js` (151 lines) — Code graph MCP
  - `bin/executor.js` (338 lines) — Tool execution
  - `bin/model_client.js` (284 lines) — LLM communication
  - `bin/tools.js` (64 lines) — Tool definitions + routing
  - `bin/smallcode.js` now 1570 lines (28% reduction)
- Dependencies pinned to exact versions.
- `.env` excluded from npm package.
- README updated with accurate requirements and architecture.

## [0.4.19] - 2026-05-18

### Added
- **MCP Client** — SmallCode can now consume external MCP servers as tool providers. Configure in `.smallcode/mcp.json` or `~/.config/smallcode/mcp.json`. Tools from connected servers are auto-registered and available to the model.
  - MarrowScript source: `src/tools/mcp_client.ms`
  - JS runtime: `src/tools/mcp_client.js`
- **`/mcp` command** — Shows connected MCP servers and their available tools.
- MCP tools appear in the model's tool list as `mcp__serverName__toolName`.

## [0.4.18] - 2026-05-18

### Added
- **Programmatic API** — `const { SmallCode } = require('smallcode')` now works. Run prompts, subscribe to events (tool_start, tool_end, error, early_stop), get structured results with file changes, tool call records, and token usage.
  - MarrowScript source: `src/api/index.ms`
  - JS runtime: `src/api/index.js`
- **`main` field in package.json** — `require('smallcode')` now exports the API instead of nothing.
- **`/profile` command** added to Commands table in README.

## [0.4.17] - 2026-05-18

### Added
- **`/profile` command** — Shows detected model profile (context length, tool format, strengths/weaknesses, routing mode)
- **Repetition loop detection in streaming** — `streamFinalResponse` now uses early-stop detector to halt generation when model repeats itself
- **Governor MarrowScript updated** — `governor.marrow` now declares early-stop signals and tool routing tiers

### Fixed
- **Auth headers missing in `streamFinalResponse` and `sendToModel`** — Both streaming functions now send `Authorization` + OpenRouter headers. Previously these would 401 on cloud/authenticated endpoints.

## [0.4.16] - 2026-05-18

### Added
- **`-P` / `--prompt` flag** — Run a single prompt non-interactively: `smallcode -P "fix the bug"`
- **2-Stage Tool Router wired into agent loop** — Models with ≤16k context now get a `select_category` hint tool that reduces schema overhead. Override with `SMALLCODE_TOOL_ROUTING=direct` or `SMALLCODE_TOOL_ROUTING=two_stage`.
- **Model Profiles wired into boot** — Auto-detects model family (Gemma, Qwen, DeepSeek, etc.) from name and applies appropriate context window defaults.

## [0.4.15] - 2026-05-18

### Added
- **Early-Stop Detection Engine** — Detects and recovers from degenerate model behavior:
  - Repetition loop detection (same token sequence 3+ times → stops generation)
  - Patch spiral recovery (4+ consecutive patch failures → forces write_file rewrite)
  - Greeting regression detection (model outputs greeting mid-task → re-injects context)
  - MarrowScript source: `src/governor/early_stop.ms`
  - JS runtime: `src/governor/early_stop.js`

- **2-Stage Tool Router** (module ready, not yet wired into main loop)
  - Category selector reduces schema context by ~50% for small-context models
  - Auto-detects routing mode based on model context window (≤16k = 2-stage, >16k = direct)
  - JS runtime: `src/tools/two_stage_router.js`

- **Model Profiles** (module ready, not yet wired into main loop)
  - Per-model capability detection via fuzzy name matching
  - Profiles for Gemma 4, Qwen 3/2.5, DeepSeek, CodeLlama, Mistral Nemo, StarCoder
  - Drives routing mode, tool format, and context budget decisions
  - JS runtime: `src/model/profiles.js`

### Fixed
- **"Exit code undefined" display bug** — When `execSync` throws without a status code (e.g. EPERM, ENOENT), the error message now correctly shows "Timed out" instead of "Exit code undefined".

## [0.4.13] - 2026-05-18

### Fixed
- **Install no longer requires C++ build tools** — `budget-aware-mcp` (which needs `better-sqlite3` native compilation) moved to `optionalDependencies`. Install succeeds even without Python/gcc/make. SmallCode gracefully falls back to JSON-based memory when SQLite isn't available.
- **Playwright also made optional** — Web browsing (disabled by default anyway) won't block install on systems without Chromium deps.
- **Top-level require crash** — The `require('budget-aware-mcp')` was outside try/catch, crashing on startup if the module failed to install. Now wrapped with graceful fallback.

### Changed
- Updated README with accurate optional requirements for code graph features.

## [0.4.12] - 2026-05-18

### Fixed
- **Startup health check fails on authenticated endpoints** — `checkOllama` now sends `Authorization: Bearer` header when probing `/models`. Previously, remote servers requiring auth (oMLX, OpenRouter, etc.) would fail the startup check even with a valid API key configured.
- **Better error messages** — Startup no longer assumes "LM Studio" for all OpenAI-compatible endpoints. Shows specific hint on 401/403 to set `OPENAI_API_KEY`.

## [0.4.11] - 2026-05-18

### Fixed
- **Critical: API key not sent in requests** — `chatCompletion` now includes `Authorization: Bearer <key>` header when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY` is set. Previously only local (no-auth) endpoints worked for the main agent loop.
- **OpenRouter support** — Added required `HTTP-Referer` and `X-Title` headers when `SMALLCODE_BASE_URL` points to `openrouter.ai`.
- **`/escalation` command crash** — `escalationEngine` was not in scope inside the command handler. Now passed as parameter to `createCommandHandler`.
- **`-v` flag collision** — `-v` was assigned to both `--version` and `--verbose`. Now `-v` is version, `-V` is verbose.
- **VERSION constant mismatch** — Was hardcoded as `0.1.0`, now reads `0.4.10` matching package.json.
- **Auto-compact destroying system messages** — Context compaction now preserves `role: 'system'` messages (skills, plugins) and only evicts user/assistant/tool messages.
- **ACP adapter version string** — Was stuck at `0.2.7`, now matches package version.

### Changed
- Removed dead `handleCommand` function from `bin/smallcode.js` (~110 lines of unreachable code).
- Pinned all dependency versions (removed caret ranges) per project conventions.
- Updated `.env.example` with OpenRouter configuration example.

## [0.2.0] - 2026-05-17

### Added
- **BoneScript Integration (Phase 1 + Phase 2 partial)**
  - `bone_compile` tool: Compile `.bone` files into complete Node.js/TypeScript backends
  - `bone_check` tool: Validate `.bone` files without generating code
  - `.bone` file validation in the improvement loop (auto-fix feedback)
  - Task classifier detects backend/API tasks and triggers BoneScript mode
  - System prompt dynamically injects BoneScript syntax guide when `taskType === 'backend'`
  - `bonescript-compiler` added as dependency (`file:../BoneScript/compiler`)
  - BoneScript quick reference module (`bin/bonescript_guide.js`)
  - Marrowscript source files for bone tools (`src/tools/builtin/bone_compile.ms`, `src/tools/builtin/bone_check.ms`)
  - Governor Marrowscript declaration updated with `backend` task type
  - Verifier updated to validate `.bone` files via `bone_check`

- **Model Escalation Engine**
  - When local model hard fails after decompose, escalate to a stronger model (Claude/OpenAI/DeepSeek)
  - Opt-in: requires API key via env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) or `[escalation]` config
  - Supports Anthropic Messages API and OpenAI-compatible endpoints
  - Session-limited (default 5 escalations per session)
  - `/escalation` TUI command to view status
  - Marrowscript source: `src/governor/escalation.ms`
  - JS runtime: `bin/escalation.js`

- **Full-Screen TUI Engine**
  - Alternate screen buffer (terminal takeover, like OpenCode/vim)
  - Zero-dependency: raw ANSI escape sequences, no Ink/React/Bun needed
  - Panel layout: chat (scrollable) + optional tool panel (split view) + input + status bar
  - Raw mode input handling: arrow keys, history, PgUp/PgDn scroll, Ctrl+C exit
  - Dark/Light/Minimal themes with 24-bit RGB color support
  - Box drawing characters for borders and dividers
  - Streaming token display for real-time model output
  - Now the **default TUI** — use `--classic` flag for old readline mode
  - Marrowscript declaration: `src/tui/screen.ms`
  - JS runtime: `src/tui/fullscreen.js`

- **Plugin System**
  - Extend SmallCode with custom tools, commands, prompt injections, and hooks
  - Plugin locations: `.smallcode/plugins/` (project) and `~/.config/smallcode/plugins/` (global)
  - Each plugin is a directory with `plugin.json` manifest + JS handler files
  - Plugin tools are auto-injected into the model's tool list
  - Plugin prompts are injected into the system message based on task type
  - `/plugin list` command to show installed plugins
  - Runtime: `src/plugins/loader.js`

- **Skill System**
  - Reusable prompt templates that teach the model specific behaviors
  - Markdown files with YAML frontmatter (name, trigger, keywords)
  - Three trigger modes: `manual` (via /skill use), `auto` (always injected), `match` (keyword-activated)
  - Skills auto-activate when message matches keywords
  - `/skill list` — show all skills
  - `/skill add <name>` — create a new skill
  - `/skill use <name>` — activate for current conversation
  - `/skill remove <name>` — delete a skill
  - Skill locations: `.smallcode/skills/` (project) and `~/.config/smallcode/skills/` (global)
  - Runtime: `src/plugins/skills.js`

### Changed
- `bin/governor.js` — `classifyTask()` now detects backend/API creation tasks, scoped to Node.js/TypeScript only (respects Python/Go/Rust/etc)
- `bin/smallcode.js` — System prompt conditionally includes BoneScript guide; improvement loop now tracks decompose attempts and escalates on 2nd failure
- `bin/commands.js` — Added `/escalation` command
- `smallcode.toml` — Added `[escalation]` config section
- `src/tools/registry.ms` — Registered `bone_compile` and `bone_check` tools
- `src/governor/verifier.ms` — Added `.bone` extension to compile validation pipeline
- `src/governor/governor.marrow` — Added "backend" to task type constraint enum

## [0.1.0] - Initial Release

- Core agent loop with tool calling
- Improvement loop with auto-validation
- Governor with tool scoring and hard fail
- Compound tools for reduced tool call chains
- Memory integration (budget-aware-mcp SQLite+FTS5)
- Code graph MCP integration
- TUI with slash commands
- Model profiles for small LLMs
