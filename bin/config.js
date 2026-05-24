// SmallCode — Configuration
// Loads config from .env, smallcode.toml, and CLI flags

const path = require('path');
const fs = require('fs');
const os = require('os');

function loadConfig(flags = {}) {
  const env = process.env;

  const config = {
    model: {
      provider: env.SMALLCODE_PROVIDER || 'openai',
      name: env.SMALLCODE_MODEL || '',
      baseUrl: env.SMALLCODE_BASE_URL || (env.OLLAMA_HOST ? (env.OLLAMA_HOST + '/v1') : 'http://localhost:1234/v1'),
      timeout: parseInt(env.SMALLCODE_MODEL_TIMEOUT) || 300, // seconds; 5 min default for slow hardware
    },
    context: {
      max_budget_pct: parseInt(env.SMALLCODE_CONTEXT_BUDGET) || 70,
      detected_window: parseInt(env.SMALLCODE_CONTEXT_WINDOW) || 128000,
      working_memory_tokens: 500,
      summary_threshold: 200,
    },
    tools: {
      bash_timeout: parseInt(env.SMALLCODE_BASH_TIMEOUT) || 30,
    },
    tui: {
      show_token_usage: true,
      auto_approve: env.SMALLCODE_AUTO_APPROVE === 'true',
      theme: env.SMALLCODE_THEME || 'dark',
    },
    escalation: {
      enabled: true,
      max_per_session: parseInt(env.SMALLCODE_ESCALATION_MAX) || 5,
      confirm: env.SMALLCODE_ESCALATION_CONFIRM !== 'false',
      provider: null,
      api_key: null,
      model: env.SMALLCODE_ESCALATION_MODEL || null,
    },
    git: {
      auto_commit: env.SMALLCODE_AUTO_COMMIT === 'true',
    },
  };

  // Multi-model routing (optional)
  if (env.SMALLCODE_MODEL_FAST || env.SMALLCODE_MODEL_STRONG) {
    config.models = {
      fast: env.SMALLCODE_MODEL_FAST || config.model.name,
      default: env.SMALLCODE_MODEL_DEFAULT || config.model.name,
      strong: env.SMALLCODE_MODEL_STRONG || config.model.name,
    };
  }

  // Legacy: still check smallcode.toml / config.toml for backwards compatibility
  const tomlPaths = [
    path.join(process.cwd(), 'smallcode.toml'),
    path.join(process.cwd(), '.smallcode', 'config.toml'),
    path.join(os.homedir(), '.config', 'smallcode', 'config.toml'),
  ];
  for (const tomlPath of tomlPaths) {
    if (fs.existsSync(tomlPath) && !config.model.name) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const m = line.match(/^name\s*=\s*"?([^"#]+)"?/);
          if (m) config.model.name = m[1].trim();
          const b = line.match(/^(?:baseUrl|base_url)\s*=\s*"?([^"#]+)"?/);
          if (b) config.model.baseUrl = b[1].trim();
          const p = line.match(/^provider\s*=\s*"?([^"#]+)"?/);
          if (p) config.model.provider = p[1].trim();
          const to = line.match(/^timeout\s*=\s*(\d+)/);
          if (to) config.model.timeout = parseInt(to[1]);
        }
        break;
      } catch {}
    }
  }

  // CLI flags override everything
  if (flags.model) config.model.name = flags.model;
  if (flags.provider) config.model.provider = flags.provider;
  if (flags.endpoint || flags.baseUrl) config.model.baseUrl = flags.endpoint || flags.baseUrl;
  if (flags.classic) config.tui.classic = true;

  // Normalize the base URL so common Ollama / LM Studio mistakes resolve
  // automatically. Closes #44 — "ollama Cannot reach endpoint at
  // http://localhost:11434" — Ollama's OpenAI-compatible endpoint lives at
  // /v1; the /api/* paths are the legacy Ollama-native API. Setting
  // SMALLCODE_BASE_URL=http://localhost:11434 used to fail because the
  // OpenAI-compat path tried .../models instead of .../v1/models.
  config.model.baseUrl = normalizeBaseUrl(config.model.baseUrl);

  return config;
}

/**
 * Auto-append `/v1` to known OpenAI-compatible endpoints when the user
 * didn't include it. Strips trailing slashes. No-op for URLs that already
 * end in `/v1`, contain `/v1/`, or aren't on a recognised port.
 *
 * Examples:
 *   http://localhost:11434           → http://localhost:11434/v1   (Ollama)
 *   http://localhost:1234            → http://localhost:1234/v1    (LM Studio)
 *   http://localhost:8080            → http://localhost:8080       (llama.cpp — left alone)
 *   http://localhost:11434/v1        → http://localhost:11434/v1   (no-op)
 *   http://localhost:11434/api/      → http://localhost:11434/api  (trailing slash stripped)
 */
function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let out = url.trim().replace(/\/+$/, '');
  if (!out) return url;
  // If it already routes through /v1, leave it alone.
  if (/\/v1(\/|$)/.test(out)) return out;
  // Don't touch native-Ollama paths (/api/...) — the caller is intentionally
  // hitting the legacy API.
  if (/\/api(\/|$)/.test(out)) return out;
  // Recognised OpenAI-compatible local server ports that REQUIRE /v1.
  // (llama.cpp's server defaults to 8080 but its /v1 route is also OpenAI-
  // compatible, so we append there too — but only when the path is empty.)
  const known = /:(11434|1234|8080|11435)(\/|$)/;
  let hasPath = false;
  try {
    const u = new URL(out);
    hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
  } catch {
    return out;
  }
  if (hasPath) return out;
  if (known.test(out)) return out + '/v1';
  return out;
}

/**
 * Check if the model endpoint is reachable.
 * Returns true if connected, false otherwise.
 */
async function checkEndpoint(config) {
  const baseUrl = config.model.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';

  // OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter, etc.)
  if (config.model.provider === 'openai' || baseUrl.includes('/v1')) {
    try {
      const headers = {};
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${baseUrl}/models`, { headers });
      if (!response.ok) {
        console.log(`  ⚠ Cannot reach endpoint at ${baseUrl}`);
        console.log(`  Got HTTP ${response.status} from ${baseUrl}/models`);
        if (response.status === 404 && !/\/v1(\/|$)/.test(baseUrl)) {
          // The most common cause: user gave a base URL without /v1.
          console.log(`  Tip: this URL has no /v1 path. Try SMALLCODE_BASE_URL=${baseUrl}/v1 in your .env.`);
        } else {
          console.log(`  Check that your model server is running and accessible.`);
        }
        if (response.status === 401 || response.status === 403) {
          console.log(`  Got ${response.status} — set OPENAI_API_KEY in .env if your server requires auth.`);
        }
        return false;
      }
      const data = await response.json();
      const models = data.data || [];
      if (models.length > 0) {
        console.log(`  Connected: ${baseUrl}`);
        console.log(`  Model: ${config.model.name}`);
        const activeModel = models.find(m => (m.id || m.name || '').includes(config.model.name)) || models[0];
        if (activeModel && activeModel.context_length) {
          config.context.detected_window = activeModel.context_length;
          console.log(`  Context: ${activeModel.context_length} tokens`);
        }
      }
      return true;
    } catch (e) {
      console.log(`  ⚠ Cannot reach endpoint at ${baseUrl}`);
      console.log(`  Check that your model server is running and the URL is correct.`);
      return false;
    }
  }

  // Ollama endpoint
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const response = await fetch(`${host}/api/tags`);
    if (!response.ok) return false;
    const data = await response.json();
    const models = data.models || [];
    const hasModel = models.some(m => m.name.includes(config.model.name.split(':')[0]));
    if (!hasModel) {
      console.log(`  ⚠ Model "${config.model.name}" not found in Ollama.`);
      console.log(`  Run: ollama pull ${config.model.name}`);
      return false;
    }
    return true;
  } catch {
    console.log('  ⚠ Ollama not running. Start it with: ollama serve');
    return false;
  }
}

/**
 * Build auth headers for API requests.
 *
 * Provider-aware: picks the right API key based on the target URL, so users
 * with multiple keys configured (common when escalation is enabled) don't
 * accidentally send an OpenAI key to DeepSeek or vice versa.
 */
function buildAuthHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  const baseUrl = (config.model.baseUrl || '').toLowerCase();

  // Route key selection based on the target endpoint URL.
  let apiKey = null;
  if (baseUrl.includes('api.deepseek.com')) {
    apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || config.model.apiKey;
  } else if (baseUrl.includes('api.openai.com')) {
    apiKey = process.env.OPENAI_API_KEY || config.model.apiKey;
  } else if (baseUrl.includes('openrouter.ai')) {
    apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || config.model.apiKey;
  } else if (baseUrl.includes('anthropic.com')) {
    // Anthropic uses x-api-key, not Bearer — but if someone routes through
    // an OpenAI-compat proxy, Bearer still works. We use ANTHROPIC_API_KEY
    // first, then fall back to the generic key.
    apiKey = process.env.ANTHROPIC_API_KEY || config.model.apiKey;
  } else {
    // Local server or unknown cloud — fall back to any available key.
    // SMALLCODE_API_KEY is the explicit "my endpoint needs this key" option.
    apiKey = process.env.SMALLCODE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
    headers['X-Title'] = 'SmallCode';
  }
  return headers;
}

module.exports = { loadConfig, checkEndpoint, buildAuthHeaders, normalizeBaseUrl };
