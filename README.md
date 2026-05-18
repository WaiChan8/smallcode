# ⚡ SmallCode

**AI coding agent optimized for small LLMs (≤20B parameters)**

SmallCode is a terminal-native coding agent designed from the ground up to extract useful work from local models (7B-20B) running on consumer hardware. While tools like OpenCode assume frontier models with 128k+ context and perfect tool calling, SmallCode compensates for the limitations of small models through intelligent architecture.

## Why SmallCode?

| | OpenCode | SmallCode |
|---|----------|-----------|
| **Target** | Frontier models (Claude, GPT-4) | 7B-20B local models |
| **Context** | Dumps everything | Budget-managed, summarized |
| **Tool calling** | Assumes reliable JSON | Forgiving multi-format parser |
| **Planning** | Single-shot | TODO-file decomposed steps |
| **Editing** | Full file write | Search-and-replace patch |
| **Privacy** | API calls to cloud | Fully local, no network needed |

## Quick Start

```bash
# Install globally
npm install -g smallcode

# Or run directly with npx
npx smallcode

# Start in your project directory
cd my-project
smallcode
```

SmallCode includes [BoneScript](https://github.com/Doorman11991/BoneScript) and [budget-aware-mcp](https://github.com/Doorman11991/budget-aware-mcp) as dependencies — everything installs in one go.

```bash
# Install MarrowScript compiler
npm install -g marrowscript-compiler

# Compile the agent system
marrowc compile smallcode.marrow

# Setup
cd output
npm install
cp .env.example .env
# Edit .env — set OLLAMA_HOST if not default

# Index your codebase (builds symbol graph for retrieval)
npx ts-node bin/index_sources.ts /path/to/your/project

# Run
npm run dev
```

## Architecture

SmallCode is declared as a **MarrowScript system** with the cognition layer.
The compiler produces the entire agent runtime deterministically:

```
smallcode.marrow (declarative system spec)
    ↓ marrowc compile
    ↓
output/
├── src/
│   ├── cognition/          ← Compiled from prompts/routers/primitives
│   │   ├── router.ts       Tier-based model dispatch
│   │   ├── prompts.ts      Typed prompt functions with validation+repair
│   │   ├── primitives.ts   compress_context, semantic_slice, decompose_task, etc.
│   │   ├── validate.ts     Schema + AST validation
│   │   ├── repair.ts       Per-prompt repair functions
│   │   ├── budget.ts       Token/cost budget tracking
│   │   ├── cache.ts        Prompt response caching
│   │   └── traces.ts       Full observability spans
│   ├── providers/          ← Model provider adapters
│   │   ├── ollama.ts
│   │   ├── openai_compat.ts
│   │   └── llamacpp.ts
│   ├── memory/             ← Semantic retrieval layer
│   │   ├── semantic_index.ts
│   │   ├── retriever.ts    Bounded BFS graph walk
│   │   └── compressor.ts   Token-budgeted summarization
│   ├── routes/             ← API endpoints
│   └── flows.ts            ← Saga runtime with checkpoints
├── migrations/             ← DB schema (traces, cache, budgets)
├── bin/index_sources.ts    ← Offline code indexer
├── extensions/             ← Prompt templates (survive recompilation)
└── src/tui/                ← Terminal interface (Marrowscript imperative layer)
```

## Key Features

### 🦴 BoneScript Integration
For Node.js/TypeScript backends, SmallCode uses BoneScript — write ONE `.bone` file and compile it to a complete project (routes, auth, DB, events, migrations, SDK, admin panel, Docker, CI). Reduces 8-15 tool calls to 1-2, dramatically improving reliability with small models.

### ⬆ Model Escalation
When the local model hard fails after retry + decompose, SmallCode can optionally escalate to a stronger cloud model (Claude, OpenAI, DeepSeek). Fully opt-in — requires an API key. Session-limited to prevent runaway costs. The escalation model gets full context of what was tried and what failed.

### 🧠 Context Budget Engine
Never exceeds your model's context window. Automatically summarizes large files to signatures, evicts old messages, and tracks token usage in real time.

### 🔀 2-Stage Tool Routing
Halves the schema context overhead. Model picks a category (read/write/search/run/plan) first, then gets only relevant tool schemas. Critical for models with 8-16k context.

### 🛠 Forgiving Tool Call Parser
Small models produce messy output. SmallCode parses tool calls from JSON, YAML, XML, Hermes format, or plain text. Auto-repairs common mistakes (wrong param names, type mismatches).

### 📋 TODO-Driven Planning
Complex tasks get decomposed into atomic steps. The model reads a TODO file each turn to know where it is. Each step is validated (lint/compile) before moving on.

### ✏️ Patch-First Editing
Search-and-replace as the primary edit primitive. Small models can't reliably reproduce entire files — they truncate, hallucinate, or drift. `patch` is safer and more context-efficient.

### 🔄 Early-Stop Detection
Detects repetition loops and runaway output. Saves tokens and time when a small model starts spinning.

### 📊 Model Profiles
Per-model configuration: context length, tool format (native/hermes/json/xml/text), chat template, strengths/weaknesses. Auto-adapts prompting strategy.

### 💾 Working Memory
Persistent scratchpad that survives across turns. Compensates for limited reasoning depth — the model can write notes to itself.

## Supported Models

| Model | Size | Context | Tool Calling | Rating |
|-------|------|---------|--------------|--------|
| Qwen2.5-Coder-14B | 14B | 32k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Qwen3-8B | 8B | 32k | ✅ Native | ⭐⭐⭐⭐ |
| Devstral Small | ~14B | 32k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Mistral-Nemo-12B | 12B | 32k | ✅ Native | ⭐⭐⭐⭐ |
| DeepSeek-Coder-V2-Lite | 16B | 16k | ❌ Text | ⭐⭐⭐ |
| CodeLlama-13B | 13B | 16k | ❌ Text | ⭐⭐⭐ |
| StarCoder2-15B | 15B | 16k | ❌ Text | ⭐⭐ |
| Phi-3-Mini | 3.8B | 4k | ❌ Text | ⭐⭐ |

## Configuration

Project-level `smallcode.toml`:

```toml
[model]
provider = "ollama"
name = "qwen2.5-coder-14b"

[context]
max_budget_pct = 70
working_memory_tokens = 500
summary_threshold = 200

[tools]
enabled = ["read_file", "write_file", "patch", "bash", "search", "find_files", "symbols", "memory", "plan"]
bash_timeout = 30

[planner]
auto_plan = true
max_retries = 2
validate_after_edit = true

[tui]
show_token_usage = true
auto_approve = false
```

## Commands

| Command | Description |
|---------|-------------|
| `/quit`, `/q` | Exit SmallCode |
| `/clear` | Reset conversation |
| `/stats` | Show session statistics |
| `/memory` | Show working memory |
| `/plan` | Show current task plan |
| `/model` | Show/switch model |
| `/help` | Show all commands |

## Tools

| Tool | Description |
|------|-------------|
| `bone_compile` | Compile .bone → full backend project |
| `bone_check` | Validate .bone file (type errors, constraints) |
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `patch` | Search-and-replace edit |
| `bash` | Run shell commands |
| `search` | Regex search (ripgrep) |
| `find_files` | Glob file search |
| `graph_search` | Code graph symbol search |
| `memory_load` | Load relevant project memory |
| `memory_remember` | Save knowledge to memory |

## Architecture

SmallCode uses **MarrowScript's cognition layer** for deterministic LLM orchestration:

```
┌──────────────────────────────────────────┐
│            TUI (Terminal UI)              │ ← Marrowscript imperative
├──────────────────────────────────────────┤
│    MarrowScript Cognition Runtime        │ ← Compiled from .marrow
│  ┌────────────┬──────────┬───────────┐  │
│  │  Router    │ Prompts  │ Primitives│  │
│  │ (tier-    │ (typed,  │ (closed   │  │
│  │  based)   │ cached,  │  catalog) │  │
│  │           │ repaired)│           │  │
│  └────────────┴──────────┴───────────┘  │
├──────────────────────────────────────────┤
│  Traces │ Budget │ Cache │ Validation   │
├──────────────────────────────────────────┤
│   Ollama │ llama.cpp │ OpenAI-compat    │
├──────────────────────────────────────────┤
│  Semantic Index (graph-based retrieval)  │
└──────────────────────────────────────────┘
```

### What MarrowScript Gives Us (vs hand-rolling)

| Feature | Hand-rolled (OpenCode) | MarrowScript |
|---------|----------------------|--------------|
| Model routing | Custom if/else | Declarative tier ladder, deterministic |
| Prompt validation | Ad-hoc | Typed returns, schema/AST validation |
| Retry + repair | Manual retry loops | Compiled retry policies with repair prompts |
| Token budgets | None / manual | Per-user/per-feature sliding windows |
| Tracing | Manual logging | Automatic spans on every LLM boundary |
| Tool calling | Trust model JSON | Bounded (max 5), closed allowlist |
| Context compression | Manual truncation | `compress_context` primitive with summarizer |
| Code retrieval | Grep / full file dump | `semantic_slice` bounded graph BFS |
| Task planning | Model freestyle | `decompose_task` with closed kind list |
| Prompt regression | None | `evaluation` declarations with CI baselines |
| Edit approval | Custom UI | Flow checkpoints with typed decisions |
| Replay/debug | None | `marrowc replay <trace_id>` |

## Providers

- **Ollama** (recommended) — local, private, easy setup
- **llama.cpp** — direct GGUF loading, minimal overhead
- **OpenAI-compatible** — vLLM, LM Studio, text-gen-webui
- **OpenAI** — GPT-4o-mini, GPT-4o
- **Anthropic** — Claude Haiku, Sonnet

## Hooks

Automate actions on events:

```json
{
  "name": "Lint After Edit",
  "version": "1.0.0",
  "when": { "type": "post_tool", "toolNames": ["patch", "write_file"] },
  "then": { "type": "run_command", "command": "npm run lint --silent" }
}
```

Place hook files in `.smallcode/hooks/` (project) or `~/.config/smallcode/hooks/` (global).

## Design Principles

1. **Declare, don't implement** — The cognition runtime is compiled from `smallcode.marrow`. You declare models, prompts, routers, and flows. MarrowScript generates the wiring.
2. **Budget everything** — Token budgets, cost budgets, call caps. Small models waste tokens; the system prevents runaway spending.
3. **Closed catalogs** — Tools come from a closed list. Cognition primitives come from a closed catalog. The model never invents new ones.
4. **Deterministic routing** — Same task complexity always selects the same model tier. No non-determinism outside the LLM call itself.
5. **Validate and repair** — Every prompt output is validated. Failed outputs get a bounded repair attempt before escalating.
6. **Patch over rewrite** — Search-and-replace is safer than reproducing entire files.
7. **Trace everything** — Every LLM boundary writes a span. Replay any session. Convert traces to regression tests.
8. **Bounded retrieval** — Never dump the whole repo. Walk the symbol graph to depth 2, capped at 8 files.

## MarrowScript Cognition Primitives Used

| Primitive | Category | What it does in SmallCode |
|-----------|----------|--------------------------|
| `semantic_slice` | retrieval | Bounded code retrieval via symbol graph |
| `compress_context` | memory | Summarize old turns when budget is tight |
| `decompose_task` | planning | Break complex tasks into atomic steps |
| `self_critique` | validation | Validate edits against criteria |
| `repair_with_diff` | recovery | Fix failed tool calls |

## License

MIT
