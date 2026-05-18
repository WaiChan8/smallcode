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

### Requirements

- Node.js 18+
- A local LLM server (LM Studio, Ollama, or any OpenAI-compatible endpoint)

### Configuration

Edit `smallcode.toml` in your project root:

```toml
[model]
provider = "openai"
name = "your-model-name"
# baseUrl defaults to http://localhost:1234/v1 (LM Studio)

[escalation]
# Optional: auto-escalate to cloud model on hard fail
# provider = "anthropic"
# api_key = "sk-ant-..."
```

Or set environment variables:
```bash
export OLLAMA_HOST=http://localhost:11434
export ANTHROPIC_API_KEY=sk-ant-...  # optional, for escalation
```

## Architecture

SmallCode is built with a modular architecture:

`
bin/
├── smallcode.js        Main entry point + agent loop
├── governor.js         Tool scoring, verification, decompose
├── escalation.js       Cloud model fallback (Claude/OpenAI)
├── commands.js         TUI slash commands
├── tui.js              Classic TUI renderer
└── bonescript_guide.js BoneScript syntax reference

src/
├── tui/fullscreen.js   Fullscreen alternate-buffer TUI
├── plugins/loader.js   Plugin system
├── plugins/skills.js   Skill system
├── tools/builtin/      Tool implementations
├── governor/           Verifier, scorer, hard fail
└── core/               Config, events, session
`

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

Any OpenAI-compatible endpoint works. Tested and rated with SmallCode's harness:

| Model | Size | Context | Tool Calling | Rating |
|-------|------|---------|--------------|--------|
| Gemma 4 E4B (MoE) | 8B/4B active | 256k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Qwen 3.5-8B | 8B | 128k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Devstral Small | 14B | 128k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Qwen 3.5-14B | 14B | 128k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Gemma 4 27B (MoE) | 27B/4B active | 256k | ✅ Native | ⭐⭐⭐⭐⭐ |
| Llama 4 Scout | 17B active | 512k | ✅ Native | ⭐⭐⭐⭐ |
| Mistral Small 3.2 | 24B | 128k | ✅ Native | ⭐⭐⭐⭐ |
| Phi-4 Mini | 3.8B | 128k | ✅ Native | ⭐⭐⭐ |
| DeepSeek-R1-0528 (distill) | 14B | 64k | ✅ Native | ⭐⭐⭐⭐ |

**Escalation targets** (cloud, used only on hard fail):
- Claude Sonnet 4 / Haiku 4
- GPT-4o / GPT-4o-mini
- DeepSeek Coder

## Configuration

Project-level `smallcode.toml`:

```toml
[model]
provider = "openai"
name = "gemma-4-e4b"

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

## License

MIT
