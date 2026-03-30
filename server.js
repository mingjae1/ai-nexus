const express = require('express');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const app = express();
const PORT = 7899;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const CONFIG_PATH = path.join(__dirname, 'wizard-config.json');
const MODEL_SPECS_PATH = path.join(__dirname, 'plan', 'model-specs.json');
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const RADIT_STAGES = ['R', 'A', 'D', 'I', 'T', 'S', 'F'];
const COMMAND_TIMEOUT_MS = 15000;
const CLI_PING_TIMEOUT_MS = 20000;
const CLI_PING_PROMPT = 'Reply with OK only.';
const CLI_PROVIDER_MAP = Object.freeze({ claude: 'claude', gemini: 'gemini', codex: 'openai' });
const CLI_MODEL_FLAGS = Object.freeze({
  claude: (modelId) => `claude -p "{task}" --model ${modelId}`,
  gemini: (modelId) => `gemini -p "{task}" --model ${modelId}`,
  codex: (modelId) => `codex -q "{task}" --model ${modelId}`
});
const ORCHESTRATOR_SETUP = Object.freeze({
  claude: {
    instructionsPath: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
    workers: {
      'gemini-cli': { command: 'gemini', args: ['--acp'], type: 'stdio' },
      'codex-cli': { command: 'codex', args: ['mcp-server'], type: 'stdio' }
    }
  },
  gemini: {
    instructionsPath: path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    settingsPath: path.join(os.homedir(), '.gemini', 'settings.json'),
    workers: {
      'claude-code': { command: 'claude', args: ['mcp-server'], type: 'stdio' },
      'codex-cli': { command: 'codex', args: ['mcp-server'], type: 'stdio' }
    }
  },
  codex: {
    instructionsPath: path.join(os.homedir(), 'AGENTS.md'),
    settingsPath: path.join(os.homedir(), '.codex', 'config.toml'),
    isCodex: true,
    workers: {
      'claude-code': { command: 'claude', args: ['mcp-server'], type: 'stdio' },
      'gemini-cli': { command: 'gemini', args: ['--acp'], type: 'stdio' }
    }
  }
});

const WORKER_SETUP = Object.freeze({
  claude: {
    instructionsPath: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    writeMode: 'merge'
  },
  gemini: {
    instructionsPath: path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    writeMode: 'replace'
  },
  codex: {
    instructionsPath: path.join(os.homedir(), 'AGENTS.md'),
    writeMode: 'replace'
  }
});

const ORCHESTRATOR_PROMPT_PATHS = Object.freeze({
  claude: path.join(__dirname, 'plan', 'claude-orchestrator-prompt.md'),
  gemini: path.join(__dirname, 'plan', 'gemini-orchestrator-prompt.md'),
  codex: path.join(__dirname, 'plan', 'orchestrator-system-prompt.md')
});

const ORCHESTRATOR_ADAPTER_PATHS = Object.freeze({
  claude: path.join(__dirname, 'plan', 'orchestrator-adapters', 'claude.md'),
  gemini: path.join(__dirname, 'plan', 'orchestrator-adapters', 'gemini.md'),
  codex: null
});

function currentPlatformKey() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function escapePowerShellArg(value) {
  return `"${String(value || '').replace(/`/g, '``').replace(/"/g, '`"')}"`;
}

function escapePosixArg(value) {
  return `"${String(value || '').replace(/(["\\$`])/g, '\\$1')}"`;
}

function renderCommandTemplate(template, value) {
  return String(template || '')
    .replaceAll('{value_ps}', escapePowerShellArg(value))
    .replaceAll('{value_sh}', escapePosixArg(value))
    .trim();
}

function makeEnvMethod({ id, envVar, configKey, placeholder, description }) {
  return {
    id,
    type: 'env',
    label: envVar,
    description,
    configKey: configKey || '',
    envVars: [envVar],
    needsValue: true,
    placeholder: placeholder || '',
    allowExecute: false,
    commands: {
      windows: [
        { id: 'session', label: 'PowerShell (현재 세션)', template: `$env:${envVar} = {value_ps}` },
        { id: 'persist', label: '사용자 환경변수 영구 저장', template: `[Environment]::SetEnvironmentVariable('${envVar}', {value_ps}, 'User')` }
      ],
      macos: [
        { id: 'session', label: '현재 셸', template: `export ${envVar}={value_sh}` },
        { id: 'persist', label: '~/.zshrc에 추가', template: `echo 'export ${envVar}={value_sh}' >> ~/.zshrc` }
      ],
      linux: [
        { id: 'session', label: '현재 셸', template: `export ${envVar}={value_sh}` },
        { id: 'persist', label: '~/.bashrc에 추가', template: `echo 'export ${envVar}={value_sh}' >> ~/.bashrc` }
      ]
    }
  };
}

function makeLoginMethod({ id, label, description, command, args }) {
  const safeArgs = args || [];
  const commandLine = [command, ...safeArgs].join(' ');
  return {
    id,
    type: 'command',
    label,
    description,
    envVars: [],
    needsValue: false,
    allowExecute: true,
    command: { command, args: safeArgs, timeoutMs: 300000 },
    commands: {
      windows: [{ id: 'run', label: '실행', template: commandLine }],
      macos: [{ id: 'run', label: '실행', template: commandLine }],
      linux: [{ id: 'run', label: '실행', template: commandLine }]
    }
  };
}

const CLI_CATALOG = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    versionCommand: { command: 'claude', args: ['--version'] },
    authChecks: [{ command: 'claude', args: ['auth', 'status'], timeoutMs: 8000 }],
    responseCheck: null,  // claude -p fails in non-TTY subprocess; auth status is sufficient
    install: [
      { type: 'npm', command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
      { type: 'winget', command: 'winget', args: ['install', '-e', '--id', 'Anthropic.ClaudeCode'] }
    ],
    integration: { mcp: true, bash: true },
    tier: 'portable',
    subscriptionTiers: ['Free', 'Pro', 'Max', 'Team', 'Enterprise'],
    envSetup: {
      intro: 'API key 또는 브라우저 로그인 중 하나가 필요합니다.',
      methods: [
        makeEnvMethod({ id: 'anthropic-api-key', envVar: 'ANTHROPIC_API_KEY', configKey: 'claude', placeholder: 'sk-ant-...', description: 'API key 방식 (API 플랜)' }),
        makeLoginMethod({ id: 'claude-auth-login', label: 'claude auth login', description: '브라우저 OAuth 로그인 (구독 플랜)', command: 'claude', args: ['auth', 'login'] })
      ]
    }
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    versionCommand: { command: 'gemini', args: ['--version'] },
    authChecks: [],
    responseCheck: { command: 'gemini', args: ['-p', CLI_PING_PROMPT, '--model', 'gemini-2.5-flash', '--allowed-mcp-server-names', '__none__'], timeoutMs: CLI_PING_TIMEOUT_MS },
    install: [
      { type: 'npm', command: 'npm', args: ['install', '-g', '@google/gemini-cli'] },
      { type: 'winget', command: 'winget', args: ['install', '-e', '--id', 'Google.GeminiCLI'] }
    ],
    integration: { mcp: true, bash: true },
    tier: 'portable',
    subscriptionTiers: ['Free', 'Pro', 'Enterprise', 'Business' ,'Ultra'],
    envSetup: {
      intro: 'API key 또는 Google OAuth 로그인 중 하나가 필요합니다.',
      methods: [
        makeEnvMethod({ id: 'gemini-api-key', envVar: 'GEMINI_API_KEY', configKey: 'gemini', placeholder: 'AIza...', description: 'API key 방식 (API 플랜)' }),
        makeLoginMethod({ id: 'gemini-auth-login', label: 'gemini auth login', description: 'Google OAuth 로그인 (무료 플랜)', command: 'gemini', args: ['auth', 'login'] })
      ]
    }
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    versionCommand: { command: 'codex', args: ['--version'] },
    authChecks: [{ command: 'codex', args: ['login', 'status'], timeoutMs: 8000 }],
    responseCheck: { command: 'codex', args: ['exec', CLI_PING_PROMPT], timeoutMs: CLI_PING_TIMEOUT_MS },
    install: [{ type: 'npm', command: 'npm', args: ['install', '-g', '@openai/codex'] }],
    integration: { mcp: true, bash: true },
    tier: 'portable',
    subscriptionTiers: ['Free', 'Plus', 'Pro', 'Team', 'Enterprise'],
    envSetup: {
      intro: 'OPENAI_API_KEY가 필요합니다.',
      methods: [
        makeEnvMethod({ id: 'openai-api-key', envVar: 'OPENAI_API_KEY', configKey: 'openai', placeholder: 'sk-...', description: 'OpenAI API key' })
      ]
    }
  },
};

const PORTABLE_CLIS = new Set(['claude', 'codex', 'gemini']);

const NODE_INSTALL_PLANS = [
  { type: 'winget', command: 'winget', args: ['install', '-e', '--id', 'OpenJS.NodeJS.LTS'] },
  { type: 'nvm', command: 'nvm', args: ['install', 'lts'] }
];

function loadModelCatalog() {
  try {
    const raw = fs.readFileSync(MODEL_SPECS_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.models) && parsed.models.length > 0) {
      return parsed.models;
    }
  } catch (e) {
    // fallback to inline
  }
  return [
    { id: 'claude-opus-4.6', provider: 'claude', quality: 99, cost: 10, minPlan: 3, labels: ['quality', 'balanced'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'claude-sonnet-4.6', provider: 'claude', quality: 93, cost: 6, minPlan: 2, labels: ['quality', 'balanced', 'economy'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gemini-3.1-pro', provider: 'gemini', quality: 92, cost: 4, minPlan: 2, labels: ['quality', 'balanced'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gemini-2.5-pro', provider: 'gemini', quality: 89, cost: 3, minPlan: 1, labels: ['balanced', 'economy'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gpt-5.4', provider: 'openai', quality: 97, cost: 9, minPlan: 3, labels: ['quality'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gpt-5.3-codex', provider: 'openai', quality: 91, cost: 5, minPlan: 2, labels: ['quality', 'balanced'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gpt-5.4-mini', provider: 'openai', quality: 88, cost: 3, minPlan: 1, labels: ['balanced', 'economy'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gemini-3-flash', provider: 'gemini', quality: 82, cost: 1, minPlan: 0, labels: ['balanced', 'economy'], supportsReasoning: false, effortDefault: 'medium' },
    { id: 'gemini-2.5-flash', provider: 'gemini', quality: 76, cost: 1, minPlan: 0, labels: ['economy'], supportsReasoning: true, effortDefault: 'medium' },
    { id: 'gemini-2.5-flash-lite', provider: 'gemini', quality: 67, cost: 1, minPlan: 0, labels: ['economy'], supportsReasoning: false, effortDefault: 'medium' }
  ];
}

const MODEL_CATALOG = loadModelCatalog();

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']; // xhigh=Codex, max=Claude

const REASONING_MATRIX = {
  Quality: { R: 'medium', A: 'high', D: 'high', I: 'medium', T: 'medium', S: 'high', F: 'high' },
  Balanced: { R: 'low', A: 'medium', D: 'medium', I: 'low', T: 'low', S: 'low', F: 'low' },
  Economy: { R: 'low', A: 'low', D: 'low', I: 'low', T: 'low', S: 'low', F: 'low' },
  Custom: { R: 'low', A: 'medium', D: 'medium', I: 'low', T: 'low', S: 'low', F: 'low' }
};

const QUALITY_THRESHOLD = {
  Quality: 88,
  Balanced: 74,
  Economy: 0
};

const PRESET_BASELINE = {
  Quality: {
    R: 'gemini-3.1-pro',
    A: 'gemini-3.1-pro',
    D: 'claude-opus-4.6',
    I: 'gpt-5.4',
    T: 'gemini-2.5-pro',
    S: 'claude-opus-4.6',
    F: 'claude-opus-4.6'
  },
  Balanced: {
    R: 'gemini-2.5-pro',
    A: 'gemini-2.5-pro',
    D: 'claude-sonnet-4.6',
    I: 'gpt-5.3-codex',
    T: 'gemini-3-flash',
    S: 'claude-sonnet-4.6',
    F: 'claude-sonnet-4.6'
  },
  Economy: {
    R: 'gemini-3-flash',
    A: 'gemini-3-flash',
    D: 'claude-sonnet-4.6',
    I: 'gpt-5.4-mini',
    T: 'gemini-2.5-flash-lite',
    S: 'gemini-3-flash',
    F: 'gemini-3-flash'
  }
};

function isPortableTier() {
  return process.env.IS_PORTABLE === 'true';
}

function getAllowedCliIds() {
  if (!isPortableTier()) {
    return Object.keys(CLI_CATALOG);
  }
  return Object.keys(CLI_CATALOG).filter((cliId) => PORTABLE_CLIS.has(cliId));
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket.remoteAddress || '';
  const host = (req.headers.host || '').split(':')[0];
  return LOOPBACKS.has(ip) || LOOPBACKS.has(host);
}

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self';"
  );
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function requireLocalOnly(req, res, next) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function normalizeCommandText(value) {
  return String(value || '').replace(/\0/g, '').trim();
}

function firstLine(value) {
  return normalizeCommandText(value).split(/\r?\n/)[0] || '';
}

function escapeShellArg(arg) {
  return '"' + String(arg).replace(/"/g, '""') + '"';
}

function runCommand(command, args = [], options = {}) {
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : COMMAND_TIMEOUT_MS;
  const shellCmd = args.length > 0
    ? [command, ...args.map(escapeShellArg)].join(' ')
    : command;

  const result = spawnSync(shellCmd, [], {
    shell: true,
    encoding: 'utf8',
    timeout,
    input: '',
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });

  const stdout = normalizeCommandText(result.stdout);
  const stderr = normalizeCommandText(result.stderr);
  const timedOut = result.signal != null || (result.error && result.error.code === 'ETIMEDOUT');

  if (result.error && !timedOut) {
    const msg = normalizeCommandText(result.error.message);
    return { ok: false, exitCode: null, stdout: '', stderr: '', output: msg, error: msg };
  }

  return {
    ok: result.status === 0 && !timedOut,
    exitCode: result.status,
    stdout,
    stderr,
    output: stdout || stderr,
    error: result.status !== 0 ? stderr : ''
  };
}

function safeRunCommand(command, args = []) {
  return runCommand(command, args).output;
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = runCommand(checker, [command], { timeoutMs: 5000 });
  return result.ok && Boolean(result.output);
}

function parseNodeVersion(versionText) {
  const clean = String(versionText || '').trim().replace(/^v/i, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: clean };
}

function defaultConfig() {
  return {
    apiKey: { claude: '', gemini: '', openai: '' },
    orchestrator: 'claude',
    workers: [],
    mode: 'Quality',
    promptTemplatesPath: './prompt-templates',
    planType: { claude: 'subscription', gemini: 'api', codex: 'api' },
    subscriptionTier: { claude: 'Pro', gemini: 'Free', codex: 'API' },
    modelAssignment: {
      R: 'gemini-2.5-pro',
      A: 'gemini-2.5-pro',
      D: 'claude-sonnet-4.6',
      I: 'gpt-5.3-codex',
      T: 'gemini-2.5-flash',
      S: 'claude-sonnet-4.6',
      F: 'claude-sonnet-4.6'
    },
    effortAssignment: {
      R: 'medium',
      A: 'high',
      D: 'high',
      I: 'medium',
      T: 'medium',
      S: 'high',
      F: 'high'
    }
  };
}

function readConfig() {
  const fallback = defaultConfig();
  if (!fs.existsSync(CONFIG_PATH)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return sanitizeConfig(parsed);
  } catch (e) {
    return fallback;
  }
}

function sanitizeTier(cliId, tier) {
  const tiers = (CLI_CATALOG[cliId] && CLI_CATALOG[cliId].subscriptionTiers) || [];
  if (!tiers.length) {
    return '';
  }
  const normalized = String(tier || '').trim();
  return tiers.includes(normalized) ? normalized : tiers[0];
}

function sanitizeConfig(input) {
  const base = defaultConfig();
  const source = input || {};

  const apiKey = source.apiKey || {};
  const safeApi = {
    claude: typeof apiKey.claude === 'string' ? apiKey.claude.trim().slice(0, 512) : '',
    gemini: typeof apiKey.gemini === 'string' ? apiKey.gemini.trim().slice(0, 512) : '',
    openai: typeof apiKey.openai === 'string' ? apiKey.openai.trim().slice(0, 512) : ''
  };

  const cliIds = Object.keys(CLI_CATALOG);
  const safePlanType = { ...base.planType };
  const planTypeInput = source.planType || {};
  for (const cliId of cliIds) {
    const value = String(planTypeInput[cliId] || safePlanType[cliId] || 'api').toLowerCase();
    safePlanType[cliId] = value === 'subscription' ? 'subscription' : 'api';
  }

  const safeTier = { ...base.subscriptionTier };
  const tierInput = source.subscriptionTier || {};
  for (const cliId of cliIds) {
    safeTier[cliId] = sanitizeTier(cliId, tierInput[cliId] || safeTier[cliId]);
  }

  const safeMode = ['Quality', 'Balanced', 'Economy', 'Custom'].includes(source.mode) ? source.mode : base.mode;
  const orchestrator = cliIds.includes(source.orchestrator) ? source.orchestrator : base.orchestrator;
  const workersInput = Array.isArray(source.workers) ? source.workers : base.workers;
  const workers = Array.from(new Set(
    workersInput
      .map((workerId) => String(workerId || '').toLowerCase())
      .filter((workerId) => cliIds.includes(workerId) && workerId !== orchestrator)
  ));

  const modelAssignmentInput = source.modelAssignment || {};
  const safeModelAssignment = {};
  for (const stage of RADIT_STAGES) {
    const candidate = String(modelAssignmentInput[stage] || base.modelAssignment[stage] || '').trim();
    safeModelAssignment[stage] = MODEL_CATALOG.some((m) => m.id === candidate)
      ? candidate
      : base.modelAssignment[stage];
  }

  const effortAssignmentInput = source.effortAssignment || {};
  const safeEffortAssignment = {};
  for (const stage of RADIT_STAGES) {
    const candidate = String(effortAssignmentInput[stage] || base.effortAssignment[stage] || '').trim().toLowerCase();
    safeEffortAssignment[stage] = EFFORT_LEVELS.includes(candidate)
      ? candidate
      : base.effortAssignment[stage];
  }

  const rawTemplatePath = typeof source.promptTemplatesPath === 'string' ? source.promptTemplatesPath.trim() : '';
  const safePromptTemplatesPath = (rawTemplatePath && !rawTemplatePath.includes('..') && rawTemplatePath.length <= 256)
    ? rawTemplatePath
    : base.promptTemplatesPath;

  return {
    apiKey: safeApi,
    orchestrator,
    workers,
    mode: safeMode,
    promptTemplatesPath: safePromptTemplatesPath,
    planType: safePlanType,
    subscriptionTier: safeTier,
    modelAssignment: safeModelAssignment,
    effortAssignment: safeEffortAssignment
  };
}

function tierToLevel(tier) {
  const map = {
    Free: 0,
    API: 1,
    Pro: 2,
    Max: 3,
    Team: 3,
    Business: 3,
    Enterprise: 4
  };
  return map[tier] != null ? map[tier] : 1;
}

function providerForCli(cliId) {
  return CLI_PROVIDER_MAP[cliId] || cliId;
}

function getAvailableProviders(orchestratorId, workerIds) {
  const providers = new Set();
  if (CLI_PROVIDER_MAP[orchestratorId]) providers.add(CLI_PROVIDER_MAP[orchestratorId]);
  (workerIds || []).forEach((workerId) => {
    if (CLI_PROVIDER_MAP[workerId]) providers.add(CLI_PROVIDER_MAP[workerId]);
  });
  return [...providers];
}

function filterModelsByProviders(providers) {
  return MODEL_CATALOG.filter((model) => providers.includes(model.provider));
}

function normalizeWorkerIds(workerIds, orchestratorId) {
  return Array.from(new Set(
    (Array.isArray(workerIds) ? workerIds : [])
      .map((workerId) => String(workerId || '').toLowerCase())
      .filter((workerId) => CLI_CATALOG[workerId] && workerId !== orchestratorId)
  ));
}

function getCliForModel(modelId, orchestratorId, workerIds) {
  const model = MODEL_CATALOG.find((entry) => entry.id === modelId);
  if (!model) return orchestratorId;
  for (const cliId of [orchestratorId, ...(workerIds || [])]) {
    if (CLI_PROVIDER_MAP[cliId] === model.provider) return cliId;
  }
  return orchestratorId;
}

function chooseBestModel(models, mode) {
  const threshold = QUALITY_THRESHOLD[mode] || 0;
  const filtered = models.filter((m) => m.quality >= threshold);
  const target = filtered.length ? filtered : models;

  if (mode === 'Quality') {
    return target.sort((a, b) => b.quality - a.quality)[0] || null;
  }
  if (mode === 'Balanced') {
    return target.sort((a, b) => (b.quality - a.quality) - (a.cost - b.cost) * 0.5)[0] || null;
  }
  return target.sort((a, b) => a.cost - b.cost || b.quality - a.quality)[0] || null;
}

function generateRecommendation(payload) {
  const mode = ['Quality', 'Balanced', 'Economy', 'Custom'].includes(payload.mode) ? payload.mode : 'Balanced';
  const planType = payload.planType || {};
  const subscriptionTier = payload.subscriptionTier || {};
  const orchestrator = CLI_CATALOG[payload.orchestrator] ? payload.orchestrator : defaultConfig().orchestrator;
  const workers = normalizeWorkerIds(payload.workers, orchestrator);
  const availableProviders = getAvailableProviders(orchestrator, workers);

  const providerAllowance = {};
  const lowQualityModels = [];

  for (const cliId of Object.keys(CLI_CATALOG)) {
    const provider = providerForCli(cliId);
    const type = planType[cliId] || 'api';
    if (type === 'subscription') {
      const level = tierToLevel(subscriptionTier[cliId] || 'Free');
      providerAllowance[provider] = Math.max(providerAllowance[provider] || 0, level);
    } else {
      providerAllowance[provider] = Math.max(providerAllowance[provider] || 1, 1);
    }
  }

  const providerScopedModels = filterModelsByProviders(availableProviders);
  const scopedModels = providerScopedModels.filter((model) => {
    const allowance = providerAllowance[model.provider] != null ? providerAllowance[model.provider] : 1;
    if (allowance < model.minPlan) return false;
    const cliId = Object.keys(CLI_PROVIDER_MAP).find((k) => CLI_PROVIDER_MAP[k] === model.provider);
    if (cliId && model.accessType) {
      const type = planType[cliId] || 'api';
      if (model.accessType === 'api' && type === 'subscription') return false;
      if (model.accessType === 'oauth' && type === 'api') return false;
    }
    return true;
  });
  const selectionPool = scopedModels.length ? scopedModels : providerScopedModels;

  const modelAssignment = {};
  const effortAssignment = {};
  const baseline = PRESET_BASELINE[mode === 'Custom' ? 'Balanced' : mode] || PRESET_BASELINE.Balanced;
  const reasoningBaseline = REASONING_MATRIX[mode] || REASONING_MATRIX.Balanced;

  for (const stage of RADIT_STAGES) {
    const preferredId = baseline[stage];
    const preferredModel = selectionPool.find((m) => m.id === preferredId);
    if (preferredModel && preferredModel.quality >= (QUALITY_THRESHOLD[mode] || 0)) {
      modelAssignment[stage] = preferredModel.id;
      continue;
    }

    const chosen = chooseBestModel(selectionPool, mode === 'Custom' ? 'Balanced' : mode);
    modelAssignment[stage] = chosen ? chosen.id : (selectionPool[0] ? selectionPool[0].id : preferredId);
  }

  for (const stage of RADIT_STAGES) {
    const selectedModelId = modelAssignment[stage];
    const selectedModel = selectionPool.find((m) => m.id === selectedModelId) || MODEL_CATALOG.find((m) => m.id === selectedModelId);
    const matrixEffort = reasoningBaseline[stage] || 'medium';
    effortAssignment[stage] = selectedModel && selectedModel.supportsReasoning
      ? matrixEffort
      : (selectedModel && EFFORT_LEVELS.includes(selectedModel.effortDefault) ? selectedModel.effortDefault : 'medium');
  }

  for (const model of MODEL_CATALOG) {
    if ((mode === 'Quality' || mode === 'Balanced') && model.quality < QUALITY_THRESHOLD[mode]) {
      lowQualityModels.push(model.id);
    }
  }

  return {
    mode,
    orchestrator,
    workers,
    availableProviders,
    modelAssignment,
    effortAssignment,
    lowQualityModels,
    availableModels: selectionPool.map((m) => ({
      id: m.id,
      provider: m.provider,
      quality: m.quality,
      cost: m.cost,
      supportsReasoning: Boolean(m.supportsReasoning),
      effortDefault: EFFORT_LEVELS.includes(m.effortDefault) ? m.effortDefault : 'medium',
      recommended: m.quality >= (QUALITY_THRESHOLD[mode] || 0)
    }))
  };
}

function emptyProbeResult() {
  return { tested: false, ok: false, exitCode: null, summary: '', output: '', error: '' };
}

function runProbe(check) {
  if (!check || !check.command) return emptyProbeResult();
  const result = runCommand(check.command, check.args || [], { timeoutMs: check.timeoutMs });
  return {
    tested: true,
    ok: result.ok,
    exitCode: result.exitCode,
    summary: firstLine(result.output),
    output: result.output,
    error: result.stderr || result.error
  };
}

function resolveCliStatus(installed, authenticated, responseProbe, authCheckOk = false) {
  if (!installed) return 'missing';
  if (responseProbe.tested && responseProbe.ok) return 'ready';
  if (authCheckOk) return 'ready';  // auth status command confirmed → ready without needing -p ping
  if (responseProbe.tested && !responseProbe.ok) return authenticated ? 'auth_ok_no_response' : 'needs_auth';
  if (authenticated) return 'authenticated';
  return 'installed';
}

function detectCliStatus(options = {}) {
  const cliIds = Array.isArray(options.cliIds) && options.cliIds.length
    ? options.cliIds
    : Object.keys(CLI_CATALOG);
  const includeAuthCheck = options.includeAuthCheck !== false;
  const includeResponseCheck = options.includeResponseCheck !== false;

  const output = {};
  for (const cliId of cliIds) {
    const spec = CLI_CATALOG[cliId];
    if (!spec) continue;

    const installed = commandExists(spec.versionCommand.command);
    const versionResult = installed ? runProbe(spec.versionCommand) : emptyProbeResult();

    let authOk = false;
    let authProbe = emptyProbeResult();
    if (installed && includeAuthCheck && Array.isArray(spec.authChecks) && spec.authChecks.length > 0) {
      for (const check of spec.authChecks) {
        authProbe = runProbe(check);
        if (authProbe.ok) { authOk = true; break; }
      }
    }

    let responseProbe;
    if (installed && includeResponseCheck && spec.responseCheck) {
      const pingStart = Date.now();
      console.log(`[ping] ${cliId}: ${[spec.responseCheck.command, ...(spec.responseCheck.args || [])].join(' ')}`);
      responseProbe = runProbe(spec.responseCheck);
      console.log(`[ping] ${cliId}: done in ${Date.now() - pingStart}ms → exit=${responseProbe.exitCode} ok=${responseProbe.ok}`);
    } else {
      responseProbe = emptyProbeResult();
    }

    let envAuthOk = false;
    if (cliId === 'claude') envAuthOk = hasEnvValue('ANTHROPIC_API_KEY');
    if (cliId === 'gemini') envAuthOk = hasEnvValue('GEMINI_API_KEY');
    if (cliId === 'codex') envAuthOk = hasEnvValue('OPENAI_API_KEY');
    const oauthFileExists = checkOAuthTokenFile(cliId);
    const authenticatedFinal = authOk || responseProbe.ok || envAuthOk || oauthFileExists;
    const finalStatus = resolveCliStatus(installed, authenticatedFinal, responseProbe, authOk);

    console.log(`[check-cli] ${cliId}: installed=${installed} authOk=${authOk} envAuth=${envAuthOk} oauthFile=${oauthFileExists} pingOk=${responseProbe.ok} pingExit=${responseProbe.exitCode} status=${finalStatus}`);
    if (responseProbe.tested && !responseProbe.ok) {
      console.log(`[check-cli] ${cliId} ping FAILED | stdout: ${String(responseProbe.output || '').slice(0, 200)} | stderr: ${String(responseProbe.error || '').slice(0, 200)}`);
    }

    output[cliId] = {
      id: cliId,
      label: spec.label,
      installed,
      version: versionResult.ok ? firstLine(versionResult.output) : '',
      authenticated: authenticatedFinal,
      authMethod: authOk ? 'check' : responseProbe.ok ? 'response' : envAuthOk ? 'env' : oauthFileExists ? 'oauth_file' : 'none',
      hasLoginCommand: supportsLoginCommand(cliId),
      canRespond: responseProbe.ok,
      status: finalStatus,
      responseCheck: {
        tested: responseProbe.tested,
        ok: responseProbe.ok,
        summary: responseProbe.summary,
        error: responseProbe.error
      },
      _debug: {
        envAuth: envAuthOk,
        oauthFile: oauthFileExists,
        pingExitCode: responseProbe.exitCode,
        pingStdout: String(responseProbe.output || '').slice(0, 300),
        pingStderr: String(responseProbe.error || '').slice(0, 300)
      },
      integration: spec.integration,
      installOptions: spec.install,
      subscriptionTiers: spec.subscriptionTiers,
      hasEnvSetup: Boolean(spec.envSetup)
    };
  }
  return output;
}

const SETUP_CLI_IDS = Object.freeze(['claude', 'gemini', 'codex']);

function hasEnvValue(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function checkOAuthTokenFile(cliId) {
  if (cliId === 'gemini') {
    const geminiPaths = [
      path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
      path.join(os.homedir(), '.gemini', 'credentials.json'),
      path.join(os.homedir(), '.config', 'gemini', 'credentials.json')
    ];
    return geminiPaths.some((p) => {
      try {
        if (!fs.existsSync(p)) return false;
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Boolean(data.refresh_token || data.access_token);
      } catch {
        return false;
      }
    });
  }
  const tokenPaths = {
    claude: [path.join(os.homedir(), '.claude', '.credentials.json')],
    codex: [
      path.join(os.homedir(), '.codex', 'auth.json'),
      path.join(os.homedir(), '.codex', 'credentials.json'),
      path.join(os.homedir(), '.codex', '.credentials.json'),
      path.join(os.homedir(), '.config', 'codex', 'auth.json')
    ]
  };
  const paths = tokenPaths[cliId] || [];
  return paths.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function oauthProbeForCli(cliId, installed) {
  if (!installed) return emptyProbeResult();
  if (cliId === 'claude') return runProbe({ command: 'claude', args: ['auth', 'status'], timeoutMs: 8000 });
  if (cliId === 'gemini') return runProbe({ command: 'gemini', args: ['auth', 'status'], timeoutMs: 8000 });
  return emptyProbeResult();
}

function preferredTierForPlan(cliId, planType) {
  const tiers = (CLI_CATALOG[cliId] && CLI_CATALOG[cliId].subscriptionTiers) || [];
  if (!tiers.length) return '';
  if (planType === 'api') {
    if (tiers.includes('API')) return 'API';
    if (tiers.includes('Pro')) return 'Pro';
    return tiers[0];
  }
  if (tiers.includes('Pro')) return 'Pro';
  if (tiers.includes('Free')) return 'Free';
  return tiers[0];
}

function buildSetupProposal(cliId, authMethod) {
  if (authMethod === 'api-key') {
    return {
      planType: 'api',
      suggestedTier: preferredTierForPlan(cliId, 'api'),
      reason: 'API key detected'
    };
  }
  if (authMethod === 'oauth') {
    return {
      planType: 'subscription',
      suggestedTier: preferredTierForPlan(cliId, 'subscription'),
      reason: 'OAuth session detected'
    };
  }
  return {
    planType: 'api',
    suggestedTier: preferredTierForPlan(cliId, 'api'),
    reason: 'Authentication not detected'
  };
}

function detectSetupCandidates() {
  const statuses = detectCliStatus({ cliIds: SETUP_CLI_IDS });
  const detectedClis = [];

  for (const cliId of SETUP_CLI_IDS) {
    const base = statuses[cliId];
    if (!base) continue;

    const envAuth = (
      (cliId === 'claude' && hasEnvValue('ANTHROPIC_API_KEY')) ||
      (cliId === 'gemini' && hasEnvValue('GEMINI_API_KEY')) ||
      (cliId === 'codex' && hasEnvValue('OPENAI_API_KEY'))
    );
    const oauthProbe = oauthProbeForCli(cliId, base.installed);
    const oauthAuth = oauthProbe.ok;

    const authMethod = envAuth ? 'api-key' : (oauthAuth ? 'oauth' : 'unknown');
    const authenticated = Boolean(base.authenticated || envAuth || oauthAuth);
    const status = authenticated ? 'authenticated' : (base.installed ? 'partial' : 'unauthenticated');
    const canAutoSetup = authenticated;
    const setupProposal = buildSetupProposal(cliId, authMethod);

    detectedClis.push({
      id: cliId,
      label: base.label,
      authMethod,
      status,
      canAutoSetup,
      setupProposal
    });
  }

  const setupReady = detectedClis.filter((item) => item.canAutoSetup).map((item) => item.id);
  const needsManualSetup = detectedClis.filter((item) => !item.canAutoSetup).map((item) => item.id);
  return { detectedClis, setupReady, needsManualSetup };
}

function runInstallPlan(cliId, method) {
  if (cliId === 'node') {
    const plan = method ? NODE_INSTALL_PLANS.filter((item) => item.type === method) : NODE_INSTALL_PLANS;
    if (!plan.length) {
      return { ok: false, message: 'No node install plan available' };
    }
    for (const candidate of plan) {
      try {
        execFileSync(candidate.command, candidate.args || [], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, method: candidate.type, command: [candidate.command, ...(candidate.args || [])].join(' ') };
      } catch (e) {
        continue;
      }
    }
    return { ok: false, message: 'Node install command failed for all methods' };
  }

  const spec = CLI_CATALOG[cliId];
  if (!spec) {
    return { ok: false, message: 'Unsupported CLI' };
  }

  const candidates = spec.install || [];
  const plan = method ? candidates.filter((item) => item.type === method) : candidates;
  if (!plan.length) {
    return { ok: false, message: 'No install plan available' };
  }

  for (const candidate of plan) {
    try {
      execFileSync(candidate.command, candidate.args || [], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { ok: true, method: candidate.type, command: [candidate.command, ...(candidate.args || [])].join(' ') };
    } catch (e) {
      continue;
    }
  }

  return { ok: false, message: 'Install command failed for all methods' };
}

function buildAiPrompt(payload) {
  return [
    'You are an orchestration model advisor.',
    'Return a compact JSON object only with fields: rationale, assignment.',
    'assignment must contain keys R,A,D,I,T,S,F.',
    `mode=${payload.mode || 'Balanced'}`,
    `orchestrator=${payload.orchestrator || 'claude'}`,
    `planType=${JSON.stringify(payload.planType || {})}`,
    `subscriptionTier=${JSON.stringify(payload.subscriptionTier || {})}`,
    `installedCli=${JSON.stringify(payload.installedCli || {})}`,
    'Prefer high quality models in Quality mode and avoid low quality options in Balanced mode.'
  ].join('\n');
}

function runAiRecommendation(cliId, prompt) {
  const safePrompt = String(prompt || '').slice(0, 8000);
  if (cliId === 'claude') {
    const out = safeRunCommand('claude', ['-p', safePrompt]);
    return out;
  }
  if (cliId === 'gemini') {
    const out = safeRunCommand('gemini', ['-p', safePrompt]);
    return out;
  }
  if (cliId === 'codex') {
    const out = safeRunCommand('codex', ['exec', safePrompt]);
    return out;
  }
  return '';
}

const MODEL_CLI_TO_SYSTEM_CLI = Object.freeze({
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex'
});

const SYSTEM_CLI_TO_MODEL_CLI = Object.freeze({
  claude: 'claude-code',
  gemini: 'gemini-cli',
  codex: 'codex-cli'
});

const PROVIDER_DISCOVERY_APIS = Object.freeze({
  anthropic: {
    api: 'https://api.anthropic.com/v1/models',
    authHeader: 'x-api-key',
    configKey: 'claude'
  },
  openai: {
    api: 'https://api.openai.com/v1/models',
    authHeader: 'Authorization',
    configKey: 'openai'
  },
  google: {
    api: 'https://generativelanguage.googleapis.com/v1beta/models',
    authHeader: 'query',
    configKey: 'gemini'
  }
});

function readJsonFileWithBom(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    return fallbackValue;
  }
}

function writeJsonFileWithBom(filePath, value) {
  fs.writeFileSync(filePath, `\uFEFF${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildOrchestratorInstructions(orchestratorId, config) {
  const basePath = path.join(__dirname, 'plan', 'orchestrator-base.md');
  const promptPath = ORCHESTRATOR_PROMPT_PATHS[orchestratorId];
  const adapterPath = ORCHESTRATOR_ADAPTER_PATHS[orchestratorId];
  const cliLabelMap = { claude: 'claude-code', gemini: 'gemini-cli', codex: 'codex-cli' };
  const workerIds = normalizeWorkerIds(config && config.workers, orchestratorId);
  const modeLabel = workerIds.length > 0 ? 'Multi-CLI Orchestration' : 'Single-CLI Orchestration';
  const activeWorkersLabel = workerIds.length > 0
    ? workerIds.map(id => cliLabelMap[id] || id).join(', ')
    : 'none \u2014 single-CLI mode';
  const activeConfigSection = [
    '## Active Configuration (Wizard-generated \u2014 do not edit)',
    `- **Mode**: ${modeLabel}`,
    `- **Orchestrator**: ${cliLabelMap[orchestratorId] || orchestratorId}`,
    `- **Active Workers**: ${activeWorkersLabel}`,
    ''
  ].join('\n');

  let content = activeConfigSection;
  try { content += fs.readFileSync(basePath, 'utf8').replace(/^\uFEFF/, ''); } catch (e) {}
  if (promptPath) {
    try { content += '\n\n' + fs.readFileSync(promptPath, 'utf8').replace(/^\uFEFF/, ''); } catch (e) {}
  }
  if (adapterPath) {
    try { content += '\n\n' + fs.readFileSync(adapterPath, 'utf8').replace(/^\uFEFF/, ''); } catch (e) {}
  }
  const assignment = (config && config.modelAssignment) ? config.modelAssignment : null;
  const effortMap = (config && config.effortAssignment) ? config.effortAssignment : {};
  if (assignment && Object.keys(assignment).some(k => assignment[k])) {
    const stages = ['R', 'A', 'D', 'I', 'T', 'S', 'F'];
    const rows = stages.map(s => `| ${s} | ${assignment[s] || 'auto'} | ${effortMap[s] || 'auto'} |`).join('\n');
    const commandRows = stages.map((stage) => {
      const modelId = assignment[stage] || 'auto';
      const cliId = modelId === 'auto' ? orchestratorId : getCliForModel(modelId, orchestratorId, workerIds);
      const command = CLI_MODEL_FLAGS[cliId]
        ? CLI_MODEL_FLAGS[cliId](modelId)
        : `${cliId} "{task}"`;
      return `| ${stage} | ${modelId} | ${cliId} | \`${command}\` |`;
    }).join('\n');
    const singleCliReminder = workerIds.length === 0
      ? [
        '',
        '> **Single-CLI execution sequence**: Run each phase command in order. Feed the output of each phase as `--context` or as part of the next phase prompt.'
      ].join('\n')
      : '';
    const section = [
      '',
      '',
      '## RADIT Model Assignment (Wizard-configured)',
      '> Auto-generated by MMO Setup Wizard. Do not edit manually.',
      '',
      '| Phase | Model | Reasoning Effort |',
      '|-------|-------|-----------------|',
      rows,
      '',
      '> Use these exact model IDs when delegating each RADIT phase to workers.',
      '',
      '## RADIT Model Invocation Commands',
      '> Wizard-configured execution commands per phase. Replace `{task}` with actual task description.',
      '> **In single-CLI mode**: execute these bash commands sequentially, capture stdout, pass as context to next phase.',
      '> **In multi-CLI mode**: use these as reference; actual delegation is via MCP tool calls above.',
      '',
      '| Phase | Model | CLI | Command |',
      '|-------|-------|-----|---------|',
      commandRows,
      singleCliReminder
    ].join('\n');
    content = content + section;
  }
  return content.trim();
}

function buildWorkerInstructions(workerCliId, orchestratorId) {
  const workerLabel = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI' };
  const orchestratorLabel = { claude: 'claude-code', gemini: 'gemini-cli', codex: 'codex-cli' };

  return [
    `# MMO Worker — ${workerLabel[workerCliId] || workerCliId}`,
    '',
    '## Role',
    'You are a **worker** in a multi-model orchestration setup.',
    `Orchestrator: **${orchestratorLabel[orchestratorId] || orchestratorId}**`,
    '',
    'When called via MCP by the orchestrator:',
    '1. Execute the assigned task directly and completely',
    '2. Do NOT re-orchestrate or delegate — just execute',
    '3. Return structured output with RADIT Phase Header',
    '',
    '## Response Format',
    '```',
    '[RADIT Phase Header]',
    'Phase: <R|A|D|I|T|S|F>',
    `Owner: ${orchestratorLabel[workerCliId] || workerCliId}`,
    `From-To: ${orchestratorLabel[orchestratorId] || orchestratorId} -> ${orchestratorLabel[workerCliId] || workerCliId}`,
    'Objective: <one-line objective>',
    '---',
    '<result>',
    '```',
    '',
    '## Constraints',
    '- Never start a new orchestration loop',
    '- Return results in the format requested by the orchestrator',
    '- If the task is ambiguous, complete the most likely interpretation'
  ].join('\n');
}

function mergeInstructionsFile(filePath, newContent, marker) {
  const BEGIN = `<!-- MMO:BEGIN:${marker} -->`;
  const END = `<!-- MMO:END:${marker} -->`;
  const block = `${BEGIN}\n${newContent}\n${END}`;

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''); } catch (e) {}

  let updated;
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  if (existing.includes(BEGIN)) {
    updated = existing.replace(re, block);
  } else {
    updated = existing ? existing.trimEnd() + '\n\n' + block + '\n' : block + '\n';
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${updated}`, 'utf8');
}

function mergeMcpWorkers(settingsPath, workers) {
  if (!settingsPath || Object.keys(workers).length === 0) return { merged: [], skipped: [] };

  let settings = {};
  try { settings = readJsonFileWithBom(settingsPath, {}); } catch (e) {}

  if (!settings.mcpServers) settings.mcpServers = {};
  const merged = [];
  const skipped = [];
  for (const [name, entry] of Object.entries(workers)) {
    if (settings.mcpServers[name]) {
      skipped.push(name);
    } else {
      settings.mcpServers[name] = entry;
      merged.push(name);
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeJsonFileWithBom(settingsPath, settings);
  return { merged, skipped };
}

function mergeCodexMcpWorkers(workers) {
  if (!workers || Object.keys(workers).length === 0) return { merged: [], skipped: [] };

  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch (e) { existing = ''; }

  const merged = [];
  const skipped = [];

  for (const [name, entry] of Object.entries(workers)) {
    const sectionKey = `[mcp_servers.${name}]`;
    if (existing.includes(sectionKey)) {
      skipped.push(name);
      continue;
    }
    const args = Array.isArray(entry.args) ? entry.args.map((a) => `"${a}"`).join(', ') : '';
    const tomlSection = `\n[mcp_servers.${name}]\ncommand = "${entry.command}"\nargs = [${args}]\ntype = "${entry.type || 'stdio'}"\n`;
    existing += tomlSection;
    merged.push(name);
  }

  if (merged.length > 0) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, existing, 'utf8');
  }

  return { merged, skipped };
}

function selectOrchestratorWorkers(orchestratorId, workerCliIds) {
  const setup = ORCHESTRATOR_SETUP[orchestratorId];
  if (!setup || !setup.workers) return {};

  const selected = {};
  for (const workerCliId of workerCliIds) {
    const workerKey = SYSTEM_CLI_TO_MODEL_CLI[workerCliId];
    if (workerKey && setup.workers[workerKey]) {
      selected[workerKey] = setup.workers[workerKey];
    }
  }
  return selected;
}

function nowIsoString() {
  return new Date().toISOString();
}

function readApiKeyFromConfig(config, configKey) {
  const key = config && config.apiKey ? config.apiKey[configKey] : '';
  return String(key || '').trim();
}

function discoveryApiMetaByProvider(provider) {
  return PROVIDER_DISCOVERY_APIS[provider] || null;
}

function providerFromModelCli(modelCli) {
  if (modelCli === 'claude-code') return 'anthropic';
  if (modelCli === 'gemini-cli') return 'google';
  if (modelCli === 'codex-cli') return 'openai';
  return 'unknown';
}

function modelCliByProvider(provider) {
  if (provider === 'anthropic') return 'claude-code';
  if (provider === 'google') return 'gemini-cli';
  if (provider === 'openai') return 'codex-cli';
  return 'codex-cli';
}

function httpsGetJson(urlString, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const statusCode = Number(res.statusCode || 0);
        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`HTTP ${statusCode}: ${firstLine(body)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${String(e.message || e)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout (${timeoutMs}ms)`));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function extractModelIdsFromProviderResponse(provider, payload) {
  if (provider === 'anthropic') {
    const data = Array.isArray(payload && payload.data) ? payload.data : [];
    return data
      .map((item) => (item && typeof item.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean);
  }
  if (provider === 'openai') {
    const data = Array.isArray(payload && payload.data) ? payload.data : [];
    return data
      .map((item) => (item && typeof item.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean);
  }
  if (provider === 'google') {
    const data = Array.isArray(payload && payload.models) ? payload.models : [];
    return data
      .map((item) => {
        const raw = item && typeof item.name === 'string' ? item.name.trim() : '';
        return raw.startsWith('models/') ? raw.slice(7) : raw;
      })
      .filter(Boolean);
  }
  return [];
}

function extractSpecHintsFromProviderResponse(provider, payload) {
  const result = {};
  if (provider !== 'google') return result;
  const data = Array.isArray(payload && payload.models) ? payload.models : [];
  for (const model of data) {
    const raw = model && typeof model.name === 'string' ? model.name.trim() : '';
    const id = raw.startsWith('models/') ? raw.slice(7) : raw;
    if (!id) continue;
    const inputTokenLimit = Number(model.inputTokenLimit);
    const outputTokenLimit = Number(model.outputTokenLimit);
    result[id] = {
      contextWindow: Number.isFinite(inputTokenLimit) ? inputTokenLimit : null,
      maxOutputTokens: Number.isFinite(outputTokenLimit) ? outputTokenLimit : null
    };
  }
  return result;
}

function parseReasoningEffortLevels(value) {
  const raw = String(value || '').toLowerCase();
  if (!raw) return [];
  const found = [];
  for (const level of ['low', 'medium', 'high', 'xhigh']) {
    if (raw.includes(level)) found.push(level);
  }
  return found;
}

function parseMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  const parts = trimmed.split('|').slice(1, -1).map((part) => part.trim());
  return parts;
}

function parseClaudeModelsOutput(outputText) {
  const lines = String(outputText || '').split(/\r?\n/);
  const headerPattern = /^\|\s*model\s*\|\s*reasoning_effort\s*\|\s*context_window\s*\|$/i;
  const separatorPattern = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;
  const headerIndex = lines.findIndex((line) => headerPattern.test(String(line || '').trim()));
  if (headerIndex < 0) return { ok: false, models: [], specHints: {}, error: 'header_not_found' };
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const rawLine = String(lines[i] || '').trim();
    if (!rawLine) continue;
    if (separatorPattern.test(rawLine)) continue;
    if (!rawLine.startsWith('|')) continue;
    const cols = parseMarkdownTableRow(rawLine);
    if (cols.length < 3) continue;
    const modelId = String(cols[0] || '').trim();
    if (!modelId) continue;
    const contextWindow = Number(String(cols[2] || '').replace(/,/g, '').trim());
    rows.push({
      modelId,
      contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
      reasoningEffort: parseReasoningEffortLevels(cols[1] || '')
    });
  }
  if (rows.length === 0) return { ok: false, models: [], specHints: {}, error: 'no_rows' };
  const models = [];
  const specHints = {};
  const seen = new Set();
  for (const row of rows) {
    const lower = row.modelId.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    models.push(row.modelId);
    specHints[row.modelId] = {
      contextWindow: row.contextWindow,
      reasoningEffort: row.reasoningEffort
    };
  }
  return { ok: true, models: models.sort(), specHints };
}

function openAiDiscoveryCommandFromSpecs(modelSpecs) {
  const models = (modelSpecs && modelSpecs.models) || {};
  for (const [, spec] of Object.entries(models)) {
    if (!spec || spec.provider !== 'openai') continue;
    const command = spec.discoveryCommands && spec.discoveryCommands['cli-command'];
    if (typeof command === 'string' && command.trim()) {
      return command.trim();
    }
  }
  return 'claude models';
}

function fetchOpenAiModelsViaCli(modelSpecs) {
  const commandText = openAiDiscoveryCommandFromSpecs(modelSpecs);
  const cliResult = runCommand(commandText, [], { timeoutMs: 20000 });
  if (!cliResult.ok) {
    return {
      ok: false,
      models: [],
      specHints: {},
      error: cliResult.error || cliResult.stderr || 'cli_command_failed'
    };
  }
  const parsed = parseClaudeModelsOutput(cliResult.output || cliResult.stdout || '');
  if (!parsed.ok) {
    return {
      ok: false,
      models: [],
      specHints: {},
      error: parsed.error || 'parse_failed'
    };
  }
  return {
    ok: true,
    models: parsed.models,
    specHints: parsed.specHints
  };
}

async function fetchProviderModels(provider, apiKey) {
  const meta = discoveryApiMetaByProvider(provider);
  if (!meta || !apiKey) {
    return { ok: false, models: [], specHints: {}, error: 'missing_api_key' };
  }

  let url = meta.api;
  const headers = {};
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'openai') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (provider === 'google') {
    url = `${meta.api}?key=${encodeURIComponent(apiKey)}`;
  }

  try {
    const payload = await httpsGetJson(url, headers, 10000);
    const models = Array.from(new Set(extractModelIdsFromProviderResponse(provider, payload))).sort();
    return {
      ok: true,
      models,
      specHints: extractSpecHintsFromProviderResponse(provider, payload)
    };
  } catch (e) {
    return {
      ok: false,
      models: [],
      specHints: {},
      error: String(e && e.message ? e.message : e)
    };
  }
}

function listCachedModelsByProvider(modelSpecs, provider) {
  const models = (modelSpecs && modelSpecs.models) || {};
  return Object.entries(models)
    .filter(([, spec]) => spec && spec.provider === provider)
    .map(([modelId]) => modelId)
    .sort();
}

function sourceByModelId(modelSpecs, modelId) {
  const models = (modelSpecs && modelSpecs.models) || {};
  return models[modelId] && models[modelId].source ? models[modelId].source : 'unknown';
}

function buildDiscoveryResponse(modelSpecs, payloadByProvider, newModelsFound, discoveredAt) {
  const models = [];
  for (const provider of ['anthropic', 'openai', 'google']) {
    const info = payloadByProvider[provider] || { models: [] };
    for (const id of info.models || []) {
      models.push({
        id,
        provider,
        source: sourceByModelId(modelSpecs, id)
      });
    }
  }

  return {
    sources: {
      anthropic: payloadByProvider.anthropic ? payloadByProvider.anthropic.source : 'unavailable',
      openai: payloadByProvider.openai ? payloadByProvider.openai.source : 'unavailable',
      google: payloadByProvider.google ? payloadByProvider.google.source : 'unavailable'
    },
    models: models.sort((a, b) => `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`)),
    providerModels: {
      anthropic: (payloadByProvider.anthropic && payloadByProvider.anthropic.models) || [],
      openai: (payloadByProvider.openai && payloadByProvider.openai.models) || [],
      google: (payloadByProvider.google && payloadByProvider.google.models) || []
    },
    providerSpecs: {
      anthropic: (payloadByProvider.anthropic && payloadByProvider.anthropic.specHints) || {},
      openai: (payloadByProvider.openai && payloadByProvider.openai.specHints) || {},
      google: (payloadByProvider.google && payloadByProvider.google.specHints) || {}
    },
    newModelsFound: Array.from(new Set(newModelsFound)).sort(),
    timestamp: discoveredAt
  };
}

async function discoverModelsAllClis(modelSpecs, config) {
  const discoveredAt = nowIsoString();
  const payloadByProvider = {};
  const newModelsFound = [];
  const safeConfig = config || readConfig();

  for (const provider of ['anthropic', 'openai', 'google']) {
    const meta = discoveryApiMetaByProvider(provider);
    const cachedModels = listCachedModelsByProvider(modelSpecs, provider);

    if (provider === 'openai') {
      const cliDiscovered = fetchOpenAiModelsViaCli(modelSpecs);
      if (cliDiscovered.ok) {
        const cachedLower = new Set(cachedModels.map((item) => item.toLowerCase()));
        for (const modelId of cliDiscovered.models) {
          if (!cachedLower.has(modelId.toLowerCase())) {
            newModelsFound.push(modelId);
          }
        }
        payloadByProvider[provider] = {
          source: 'cli-command',
          models: Array.from(new Set([...cachedModels, ...cliDiscovered.models])).sort(),
          specHints: cliDiscovered.specHints || {}
        };
        continue;
      }
    }

    const apiKey = meta ? readApiKeyFromConfig(safeConfig, meta.configKey) : '';

    if (!apiKey) {
      payloadByProvider[provider] = {
        source: cachedModels.length > 0 ? 'cache' : 'unavailable',
        models: cachedModels,
        specHints: {}
      };
      continue;
    }

    const remote = await fetchProviderModels(provider, apiKey);
    if (!remote.ok) {
      payloadByProvider[provider] = {
        source: cachedModels.length > 0 ? 'cache' : 'unavailable',
        models: cachedModels,
        specHints: {}
      };
      continue;
    }

    const cachedLower = new Set(cachedModels.map((item) => item.toLowerCase()));
    for (const modelId of remote.models) {
      if (!cachedLower.has(modelId.toLowerCase())) {
        newModelsFound.push(modelId);
      }
    }

    payloadByProvider[provider] = {
      source: 'api',
      models: Array.from(new Set([...cachedModels, ...remote.models])).sort(),
      specHints: remote.specHints || {}
    };
  }

  return buildDiscoveryResponse(modelSpecs, payloadByProvider, newModelsFound, discoveredAt);
}

function toTokenCount(value, unit) {
  const base = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = String(unit || '').toLowerCase();
  if (suffix === 'k') return Math.round(base * 1000);
  if (suffix === 'm') return Math.round(base * 1000000);
  return Math.round(base);
}

function extractContextHints(output) {
  const text = String(output || '');
  const contextMatch = text.match(/context(?:\s*window)?[^0-9]{0,24}([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM]?)/i);
  const maxOutputMatch = text.match(/max(?:imum)?\s*output[^0-9]{0,24}([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM]?)/i);
  return {
    contextWindow: contextMatch ? toTokenCount(contextMatch[1], contextMatch[2]) : null,
    maxOutputTokens: maxOutputMatch ? toTokenCount(maxOutputMatch[1], maxOutputMatch[2]) : null
  };
}

function buildProbeCommands(systemCli, modelId, prompt) {
  if (systemCli === 'claude') {
    return [
      { command: 'claude', args: ['-p', prompt, '--model', modelId] },
      { command: 'claude', args: ['-p', prompt, '-m', modelId] }
    ];
  }
  if (systemCli === 'gemini') {
    return [
      { command: 'gemini', args: ['-p', prompt, '-m', modelId] },
      { command: 'gemini', args: ['-m', modelId, '-p', prompt] }
    ];
  }
  if (systemCli === 'codex') {
    return [
      { command: 'codex', args: ['exec', '-m', modelId, prompt] },
      { command: 'codex', args: ['-m', modelId, '-q', prompt] }
    ];
  }
  return [];
}

function probeModel(systemCli, modelId) {
  const commands = buildProbeCommands(systemCli, modelId, CLI_PING_PROMPT);
  const attempts = [];
  for (const entry of commands) {
    const start = Date.now();
    const result = runCommand(entry.command, entry.args, { timeoutMs: CLI_PING_TIMEOUT_MS });
    const latencyMs = Date.now() - start;
    const tokenHints = extractContextHints(result.output);
    const attempt = {
      command: [entry.command, ...(entry.args || [])].join(' '),
      ok: result.ok,
      exitCode: result.exitCode,
      latencyMs,
      outputPreview: firstLine(result.output),
      error: result.error || result.stderr || '',
      contextWindow: tokenHints.contextWindow,
      maxOutputTokens: tokenHints.maxOutputTokens
    };
    attempts.push(attempt);
    if (result.ok) {
      const promptTokensEstimate = Math.max(1, Math.ceil(CLI_PING_PROMPT.length / 4));
      const completionTokensEstimate = Math.max(1, Math.ceil(String(result.output || '').length / 4));
      return {
        ok: true,
        systemCli,
        modelId,
        commandUsed: attempt.command,
        latencyMs,
        promptTokensEstimate,
        completionTokensEstimate,
        contextWindow: tokenHints.contextWindow,
        maxOutputTokens: tokenHints.maxOutputTokens,
        responsePreview: attempt.outputPreview,
        attempts
      };
    }
  }
  return {
    ok: false,
    systemCli,
    modelId,
    commandUsed: null,
    latencyMs: null,
    promptTokensEstimate: Math.max(1, Math.ceil(CLI_PING_PROMPT.length / 4)),
    completionTokensEstimate: null,
    contextWindow: null,
    maxOutputTokens: null,
    responsePreview: '',
    attempts
  };
}

function inferSystemCliFromModel(modelId, explicitCli) {
  const explicit = String(explicitCli || '').toLowerCase();
  if (SYSTEM_CLI_TO_MODEL_CLI[explicit]) return explicit;
  const id = String(modelId || '').toLowerCase();
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('gpt-')) return 'codex';
  return 'codex';
}

function providerBySystemCli(systemCli) {
  if (systemCli === 'claude') return 'anthropic';
  if (systemCli === 'gemini') return 'google';
  if (systemCli === 'codex') return 'openai';
  return 'unknown';
}

function defaultDiscoveryCommandForModelCli(modelCli) {
  const provider = providerFromModelCli(modelCli);
  const meta = discoveryApiMetaByProvider(provider);
  if (meta) {
    return {
      api: meta.api,
      authHeader: meta.authHeader,
      configKey: meta.configKey
    };
  }
  return {};
}

function setNoteWithPrefix(existing, suffix) {
  return `${existing ? `${existing} ` : ''}${suffix}`.trim();
}

async function verifyModelSpecs(modelSpecs, options = {}) {
  const autoUpdate = Boolean(options.autoUpdate);
  const mismatchAction = String(options.mismatchAction || 'warn').toLowerCase();
  const config = options.config || readConfig();
  const discovered = await discoverModelsAllClis(modelSpecs, config);
  const mismatches = [];
  const nextSpecs = JSON.parse(JSON.stringify(modelSpecs || { models: {} }));
  const now = nowIsoString();
  const models = nextSpecs.models || {};

  for (const provider of ['anthropic', 'openai', 'google']) {
    if (discovered.sources[provider] !== 'api') {
      continue;
    }

    const apiModels = Array.isArray(discovered.providerModels[provider])
      ? discovered.providerModels[provider]
      : [];
    const apiMap = new Map(apiModels.map((id) => [String(id).toLowerCase(), String(id)]));
    const specModelIds = Object.entries(models)
      .filter(([, spec]) => spec && spec.provider === provider)
      .map(([modelId]) => modelId);
    const specMap = new Map(specModelIds.map((id) => [String(id).toLowerCase(), String(id)]));

    for (const [lowerId, apiModelId] of apiMap.entries()) {
      if (specMap.has(lowerId)) continue;
      mismatches.push({
        kind: 'missing',
        model: apiModelId,
        provider,
        field: 'model-specs',
        stored: false,
        discovered: true,
        confidence: 'high'
      });
      if (autoUpdate) {
        const modelCli = modelCliByProvider(provider);
        models[apiModelId] = {
          provider,
          cli: modelCli,
          contextWindow: null,
          maxOutputTokens: null,
          inputCostPer1M: null,
          outputCostPer1M: null,
          source: 'unknown',
          discoveredAt: now,
          notes: `[auto-verify] Added from ${provider} models API at ${now}.`,
          lastVerifiedAt: now,
          verificationMethod: 'api-probe',
          discoveryCommands: defaultDiscoveryCommandForModelCli(modelCli)
        };
      }
    }

    for (const [lowerId, specModelId] of specMap.entries()) {
      if (apiMap.has(lowerId)) continue;
      mismatches.push({
        kind: 'deprecated',
        model: specModelId,
        provider,
        field: 'availability',
        stored: true,
        discovered: false,
        confidence: 'high'
      });
      if (autoUpdate) {
        const existing = models[specModelId] || {};
        models[specModelId].notes = setNoteWithPrefix(
          existing.notes,
          `[auto-verify] ${provider} models API does not include this model as of ${now}.`
        );
        models[specModelId].lastVerifiedAt = now;
        models[specModelId].verificationMethod = 'api-probe';
      }
    }

    const hintsByModel = discovered.providerSpecs[provider] || {};
    for (const [lowerId, apiModelId] of apiMap.entries()) {
      if (!specMap.has(lowerId)) continue;
      const specModelId = specMap.get(lowerId);
      const stored = models[specModelId];
      const hint = hintsByModel[apiModelId] || hintsByModel[specModelId];
      if (!stored || !hint) {
        if (autoUpdate && stored) {
          stored.lastVerifiedAt = now;
          stored.verificationMethod = 'api-probe';
        }
        continue;
      }

      if (Number.isFinite(hint.contextWindow) && Number.isFinite(stored.contextWindow) && hint.contextWindow !== stored.contextWindow) {
        mismatches.push({
          kind: 'mismatch',
          model: specModelId,
          provider,
          field: 'contextWindow',
          stored: stored.contextWindow,
          discovered: hint.contextWindow,
          confidence: 'medium'
        });
        if (autoUpdate && mismatchAction === 'overwrite') {
          stored.contextWindow = hint.contextWindow;
        }
      }

      if (Number.isFinite(hint.maxOutputTokens) && Number.isFinite(stored.maxOutputTokens) && hint.maxOutputTokens !== stored.maxOutputTokens) {
        mismatches.push({
          kind: 'mismatch',
          model: specModelId,
          provider,
          field: 'maxOutputTokens',
          stored: stored.maxOutputTokens,
          discovered: hint.maxOutputTokens,
          confidence: 'medium'
        });
        if (autoUpdate && mismatchAction === 'overwrite') {
          stored.maxOutputTokens = hint.maxOutputTokens;
        }
      }

      if (autoUpdate) {
        stored.lastVerifiedAt = now;
        stored.verificationMethod = 'api-probe';
      }
    }
  }

  if (autoUpdate) {
    nextSpecs.updatedAt = now.slice(0, 10);
  }

  return { mismatches, discovered, updatedSpecs: nextSpecs };
}

app.use(applySecurityHeaders);
app.use(requireLocalOnly);
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path !== '/') {
      console.log(`[REQ] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'wizard.html'));
});

app.get('/api/check-env', (req, res) => {
  const clis = detectCliStatus({
    cliIds: ['claude', 'gemini', 'codex'],
    includeAuthCheck: false,
    includeResponseCheck: false
  });
  res.json({
    claude: {
      installed: clis.claude ? clis.claude.installed : false,
      version: clis.claude ? clis.claude.version : ''
    },
    gemini: {
      installed: clis.gemini ? clis.gemini.installed : false,
      version: clis.gemini ? clis.gemini.version : ''
    },
    codex: {
      installed: clis.codex ? clis.codex.installed : false,
      version: clis.codex ? clis.codex.version : ''
    }
  });
});

app.get('/api/check-node', (req, res) => {
  const exists = commandExists('node');
  const versionText = exists ? safeRunCommand('node', ['--version']) : '';
  const parsed = parseNodeVersion(versionText);

  if (!exists || !parsed) {
    console.log(`[check-node] installed=${exists} version=none ok=false`);
    return res.json({
      installed: false,
      status: 'missing',
      version: '',
      ok: false,
      installGuide: 'https://nodejs.org/en/download',
      autoInstall: ['winget', 'nvm']
    });
  }

  const ok = parsed.major >= 18;
  console.log(`[check-node] version=v${parsed.raw} required=18 ok=${ok}`);
  return res.json({
    installed: true,
    status: ok ? 'ok' : 'outdated',
    version: `v${parsed.raw}`,
    ok,
    installGuide: 'https://nodejs.org/en/download',
    autoInstall: ['winget', 'nvm']
  });
});

app.get('/api/tier', (req, res) => {
  const allowedClis = getAllowedCliIds();
  const portable = isPortableTier();
  res.json({
    tier: portable ? 'portable' : 'premium',
    allowedClis,
    autoCloseAfterSetup: portable
  });
});

app.get('/api/check-cli', (req, res) => {
  const allStatuses = detectCliStatus();
  const allowedClis = getAllowedCliIds();
  const filtered = {};
  for (const cliId of allowedClis) {
    if (allStatuses[cliId]) {
      filtered[cliId] = allStatuses[cliId];
    }
  }
  res.json({ clis: filtered });
});

app.get('/api/setup/detect', requireLocalOnly, (req, res) => {
  res.json(detectSetupCandidates());
});

app.post('/api/setup/apply', requireLocalOnly, (req, res) => {
  const body = req.body || {};
  const approvedInput = Array.isArray(body.approved) ? body.approved : [];
  const approved = [...new Set(approvedInput
    .map((value) => String(value || '').toLowerCase().trim())
    .filter((value) => SETUP_CLI_IDS.includes(value)))];
  const overrides = (body.overrides && typeof body.overrides === 'object') ? body.overrides : {};
  const detected = detectSetupCandidates();
  const detectedMap = new Map(detected.detectedClis.map((item) => [item.id, item]));

  const config = readConfig();
  const nextConfig = sanitizeConfig(config);
  const applied = [];
  const changes = {};

  for (const cliId of approved) {
    const candidate = detectedMap.get(cliId);
    if (!candidate || !candidate.canAutoSetup || !candidate.setupProposal) continue;

    const override = (overrides[cliId] && typeof overrides[cliId] === 'object') ? overrides[cliId] : {};
    const targetPlanType = String(override.planType || candidate.setupProposal.planType || '').toLowerCase() === 'subscription'
      ? 'subscription'
      : 'api';
    const targetTier = sanitizeTier(cliId, override.subscriptionTier || candidate.setupProposal.suggestedTier);

    const cliChanges = {};
    if (nextConfig.planType[cliId] !== targetPlanType) {
      nextConfig.planType[cliId] = targetPlanType;
      cliChanges.planType = targetPlanType;
    }
    if (nextConfig.subscriptionTier[cliId] !== targetTier) {
      nextConfig.subscriptionTier[cliId] = targetTier;
      cliChanges.subscriptionTier = targetTier;
    }

    // Security policy: do not persist raw API keys discovered from environment into wizard-config.json.

    applied.push(cliId);
    if (Object.keys(cliChanges).length > 0) {
      changes[cliId] = cliChanges;
    }
  }

  writeJsonFileWithBom(CONFIG_PATH, sanitizeConfig(nextConfig));
  const skipped = SETUP_CLI_IDS.filter((cliId) => !applied.includes(cliId));

  res.json({
    applied,
    skipped,
    changes,
    requiresRestart: false
  });
});

app.post('/api/install-cli', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  const method = String(body.method || '').toLowerCase() || null;

  if (cliId !== 'node' && !CLI_CATALOG[cliId]) {
    return res.status(400).json({ status: 'error', message: 'Unsupported CLI' });
  }

  console.log(`[install-cli] cli=${cliId} method=${method || 'auto'} 시작`);
  const result = runInstallPlan(cliId, method);
  if (!result.ok) {
    console.error(`[install-cli] cli=${cliId} method=${method || 'auto'} exit=${result.exitCode ?? '?'} ok=false | ${result.message}`);
    return res.status(500).json({ status: 'error', message: result.message || 'Install failed' });
  }

  console.log(`[install-cli] cli=${cliId} method=${method || 'auto'} ok=true`);
  res.json({ status: 'success', result });
});

app.get('/api/config', (req, res) => {
  const config = readConfig();
  const recommendation = generateRecommendation(config);
  res.json({
    config,
    modelCatalog: MODEL_CATALOG,
    cliCatalog: CLI_CATALOG,
    recommendation
  });
});

app.post('/api/config', (req, res) => {
  const payload = sanitizeConfig(req.body || {});

  try {
    fs.writeFileSync(CONFIG_PATH, `\uFEFF${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
      encoding: 'utf8'
    });
    console.log(`[config] 저장 완료: orchestrator=${payload.orchestrator} mode=${payload.mode} models=${JSON.stringify(payload.modelAssignment || {})}`);
    res.json({ status: 'success', config: payload });
  } catch (e) {
    console.error(`[config] 저장 실패: ${e.message}`);
    res.status(500).json({ status: 'error', message: '설정 저장에 실패했습니다.' });
  }
});

app.post('/api/apply-orchestrator', requireLocalOnly, (req, res) => {
  const body = req.body || {};
  const orchestratorId = String(body.orchestrator || '').toLowerCase();
  const requestedWorkers = Array.isArray(body.workers)
    ? body.workers.map((workerId) => String(workerId || '').toLowerCase())
    : [];

  if (!ORCHESTRATOR_SETUP[orchestratorId]) {
    return res.status(400).json({ status: 'error', message: '지원하지 않는 오케스트레이터입니다.' });
  }

  const setup = ORCHESTRATOR_SETUP[orchestratorId];
  const workerCliIds = Array.from(new Set(
    requestedWorkers.filter((workerId) => WORKER_SETUP[workerId] && workerId !== orchestratorId)
  ));
  const selectedWorkers = selectOrchestratorWorkers(orchestratorId, workerCliIds);
  const result = { orchestrator: orchestratorId, instructions: false, mcpWorkers: { merged: [], skipped: [] }, workerPrompts: [], errors: [] };

  console.log(`[orchestrator] apply 시작: orch=${orchestratorId} workers=[${workerCliIds.join(',')}]`);
  try {
    const content = buildOrchestratorInstructions(orchestratorId, config);
    if (content) {
      if (orchestratorId === 'claude') {
        // Claude: CLAUDE.md has other content (D-phase contract) — use marker merge
        mergeInstructionsFile(setup.instructionsPath, content, 'RADIT-ORCHESTRATOR');
      } else {
        // Gemini/Codex: instruction file IS the orchestrator prompt — full replace
        fs.mkdirSync(path.dirname(setup.instructionsPath), { recursive: true });
        fs.writeFileSync(setup.instructionsPath, `\uFEFF${content}\n`, 'utf8');
      }
      result.instructions = true;
    }
  } catch (e) {
    result.errors.push(`instructions: ${e.message}`);
  }

  try {
    let mcpResult;
    if (setup.isCodex) {
      mcpResult = mergeCodexMcpWorkers(selectedWorkers);
    } else {
      mcpResult = mergeMcpWorkers(setup.settingsPath, selectedWorkers);
    }
    result.mcpWorkers = mcpResult;
  } catch (e) {
    result.errors.push(`mcp: ${e.message}`);
  }

  const workerResults = [];
  for (const workerCliId of workerCliIds) {
    const workerSetup = WORKER_SETUP[workerCliId];
    if (!workerSetup) continue;

    const workerResult = { cli: workerCliId, ok: false, error: '' };
    try {
      const content = buildWorkerInstructions(workerCliId, orchestratorId);
      if (workerSetup.writeMode === 'merge') {
        mergeInstructionsFile(workerSetup.instructionsPath, content, 'MMO-WORKER');
      } else {
        fs.mkdirSync(path.dirname(workerSetup.instructionsPath), { recursive: true });
        fs.writeFileSync(workerSetup.instructionsPath, `\uFEFF${content}\n`, 'utf8');
      }
      workerResult.ok = true;
    } catch (e) {
      workerResult.error = e.message;
      result.errors.push(`worker-${workerCliId}: ${e.message}`);
    }
    workerResults.push(workerResult);
  }

  result.workerPrompts = workerResults;

  try {
    const config = readConfig();
    config.orchestrator = orchestratorId;
    config.workers = workerCliIds;
    writeJsonFileWithBom(CONFIG_PATH, sanitizeConfig(config));
  } catch (e) {
    result.errors.push(`config: ${e.message}`);
  }

  const applyStatus = result.errors.length === 0 ? 'success' : 'partial';
  if (result.errors.length > 0) {
    console.error(`[apply-orchestrator] orch=${orchestratorId} status=${applyStatus} errors=[${result.errors.join(' | ')}]`);
  } else {
    console.log(`[apply-orchestrator] orch=${orchestratorId} workers=[${workerCliIds.join(',')}] instructions=${result.instructions} mcp=${result.mcpWorkers.merged.length} merged ok`);
  }
  res.json({ status: applyStatus, ...result });
});

app.get('/api/recommend-models', (req, res) => {
  const mode = String(req.query.mode || 'Balanced');
  const config = readConfig();
  const orchestrator = CLI_CATALOG[String(req.query.orchestrator || '').toLowerCase()]
    ? String(req.query.orchestrator || '').toLowerCase()
    : config.orchestrator;
  const workerQuery = Array.isArray(req.query.workers)
    ? req.query.workers
    : typeof req.query.workers === 'string'
      ? req.query.workers.split(',')
      : config.workers;
  const workers = normalizeWorkerIds(
    workerQuery,
    orchestrator
  );
  const payload = {
    mode,
    planType: config.planType,
    subscriptionTier: config.subscriptionTier,
    orchestrator,
    workers
  };
  const recommendation = generateRecommendation(payload);
  res.json(recommendation);
});

app.post('/api/recommend-models', (req, res) => {
  const body = req.body || {};
  const orchestrator = CLI_CATALOG[String(body.orchestrator || '').toLowerCase()]
    ? String(body.orchestrator || '').toLowerCase()
    : defaultConfig().orchestrator;
  const workers = normalizeWorkerIds(body.workers, orchestrator);
  const payload = {
    mode: String(body.mode || 'Balanced'),
    planType: body.planType || {},
    subscriptionTier: body.subscriptionTier || {},
    orchestrator,
    workers
  };
  const recommendation = generateRecommendation(payload);
  const assignedCount = Object.keys(recommendation.modelAssignment || {}).length;
  console.log(`[recommend-models] mode=${payload.mode} orch=${orchestrator} workers=[${workers.join(',')}] tier=${JSON.stringify(payload.subscriptionTier)} → ${assignedCount} assignments`);
  res.json(recommendation);
});

app.post('/api/ai-recommend', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  const installedCli = detectCliStatus({ includeAuthCheck: false, includeResponseCheck: false });
  const portable = isPortableTier();

  if (!CLI_CATALOG[cliId]) {
    return res.status(400).json({ status: 'error', message: '지원하지 않는 CLI입니다.' });
  }

  if (portable && !PORTABLE_CLIS.has(cliId)) {
    return res.status(403).json({ error: 'premium_required' });
  }

  if (!installedCli[cliId] || !installedCli[cliId].installed) {
    return res.status(400).json({ status: 'error', message: `${cliId} CLI가 설치되어 있지 않습니다.` });
  }

  const prompt = buildAiPrompt({
    mode: body.mode,
    orchestrator: body.orchestrator,
    planType: body.planType,
    subscriptionTier: body.subscriptionTier,
    installedCli
  });

  const output = runAiRecommendation(cliId, prompt);
  if (!output) {
    return res.status(500).json({ status: 'error', message: 'AI 추천 실행에 실패했습니다.' });
  }

  res.json({ status: 'success', cli: cliId, response: output });
});

app.post('/api/validate-run', (req, res) => {
  const text = String((req.body || {}).text || '테스트 작업').slice(0, 200);
  const result = safeRunCommand('mm', [text]);
  if (!result) {
    return res.status(500).json({ status: 'error', message: 'mm 실행 실패. PATH 또는 설치 상태를 확인하세요.' });
  }
  res.json({ status: 'success', output: result });
});

app.post('/api/test-mcp', requireLocalOnly, async (req, res) => {
  const body = req.body || {};
  const orchestratorId = String(body.orchestrator || '').toLowerCase();
  const workerIds = Array.isArray(body.workers)
    ? body.workers.map((w) => String(w).toLowerCase()).filter((w) => WORKER_SETUP[w] && w !== orchestratorId)
    : [];

  const TEST_MARKER = 'MMO-TEST-PING';
  const TEST_SECTION = `\n\n<!-- ${TEST_MARKER} -->\n## MMO Test Ping\nIf you see this section, reply with: PONG\n<!-- /${TEST_MARKER} -->`;

  const injected = [];
  const results = {};
  const errors = [];

  for (const workerId of workerIds) {
    const workerSetup = WORKER_SETUP[workerId];
    if (!workerSetup) continue;
    try {
      const filePath = workerSetup.instructionsPath;
      let existing = '';
      try { existing = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''); } catch { existing = ''; }
      if (!existing.includes(`<!-- ${TEST_MARKER} -->`)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `\uFEFF${existing}${TEST_SECTION}\n`, 'utf8');
        injected.push(workerId);
      }
    } catch (e) {
      errors.push(`inject-${workerId}: ${e.message}`);
    }
  }

  const orchSpec = CLI_CATALOG[orchestratorId];
  let pingResult = { ok: false, output: '' };
  if (orchSpec && orchSpec.responseCheck) {
    const rc = orchSpec.responseCheck;
    const r = runCommand(rc.command, rc.args, { timeoutMs: rc.timeoutMs || CLI_PING_TIMEOUT_MS });
    pingResult = { ok: r.ok, output: r.stdout || r.stderr || '' };
  }

  // 3. Directly ping each worker CLI
  const workerPings = {};
  for (const workerId of workerIds) {
    const workerSpec = CLI_CATALOG[workerId];
    if (workerSpec && workerSpec.responseCheck) {
      const rc = workerSpec.responseCheck;
      const r = runCommand(rc.command, rc.args, { timeoutMs: rc.timeoutMs || CLI_PING_TIMEOUT_MS });
      workerPings[workerId] = { ok: r.ok, output: (r.stdout || r.stderr || '').slice(0, 200) };
    } else {
      workerPings[workerId] = { ok: false, output: 'responseCheck not configured' };
    }
  }

  for (const workerId of injected) {
    const workerSetup = WORKER_SETUP[workerId];
    try {
      const filePath = workerSetup.instructionsPath;
      let content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      content = content.replace(/\n\n<!-- MMO-TEST-PING -->[\s\S]*?<!-- \/MMO-TEST-PING -->\n?/g, '');
      fs.writeFileSync(filePath, `\uFEFF${content}\n`, 'utf8');
    } catch (e) {
      errors.push(`cleanup-${workerId}: ${e.message}`);
    }
  }

  results.orchestratorPing = pingResult;
  results.workersInjected = injected;
  results.workerPings = workerPings;

  res.json({
    status: errors.length === 0 ? 'success' : 'partial',
    orchestrator: orchestratorId,
    workers: workerIds,
    results,
    errors
  });
});

const CLI_LOGIN_COMMANDS = Object.freeze({
  claude:  { command: 'claude', args: ['auth', 'login'] },
  gemini:  { command: 'gemini', args: ['auth', 'login'] },
  codex:   { command: 'codex',  args: ['login'] }
});

function supportsLoginCommand(cliId) {
  return Boolean(CLI_LOGIN_COMMANDS[cliId]);
}

function normalizePathKey(raw) {
  const value = path.normalize(String(raw || '').trim());
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function dedupePathEntries(pathValue) {
  const parts = String(pathValue || '').split(path.delimiter).map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const part of parts) {
    const key = normalizePathKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.join(path.delimiter);
}

function appendPathEntry(pathValue, dir) {
  const current = dedupePathEntries(pathValue);
  if (!dir) return current;
  const key = normalizePathKey(dir);
  const parts = current ? current.split(path.delimiter) : [];
  const exists = parts.some((part) => normalizePathKey(part) === key);
  return exists ? current : dedupePathEntries([current, dir].filter(Boolean).join(path.delimiter));
}

function refreshProcessPathFromSystem() {
  if (process.platform !== 'win32') return;
  const userPath = runCommand('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('PATH','User')"], { timeoutMs: 6000 });
  const machinePath = runCommand('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('PATH','Machine')"], { timeoutMs: 6000 });
  const merged = [
    process.env.PATH || '',
    userPath.ok ? userPath.stdout : '',
    machinePath.ok ? machinePath.stdout : ''
  ].filter(Boolean).join(path.delimiter);
  process.env.PATH = dedupePathEntries(merged);
}

function detectInstallDir(cliId) {
  const spec = CLI_CATALOG[cliId];
  const cmd = spec ? spec.versionCommand.command : (cliId === 'node' ? 'node' : null);
  if (!cmd) return null;

  refreshProcessPathFromSystem();
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const found = runCommand(checker, [cmd], { timeoutMs: 5000 });
  if (found.ok && found.stdout) {
    const hit = found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (hit) return path.dirname(hit);
  }

  // Fallback: npm global prefix for npm-installed CLIs
  const npmPrefix = runCommand('npm', ['config', 'get', 'prefix'], { timeoutMs: 5000 });
  if (npmPrefix.ok && npmPrefix.stdout) return npmPrefix.stdout.trim();
  return null;
}

function isInPath(dir) {
  if (!dir) return false;
  const key = normalizePathKey(dir);
  return String(process.env.PATH || '').split(path.delimiter)
    .some((part) => normalizePathKey(part) === key);
}

function addToPath(dir) {
  if (process.platform === 'win32') {
    const escapedDir = String(dir || '').replace(/'/g, "''");
    const script = [
      `$target='${escapedDir}'`,
      "$current=[Environment]::GetEnvironmentVariable('PATH','User')",
      "$parts=@()",
      "if (-not [string]::IsNullOrWhiteSpace($current)) { $parts=($current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }",
      "$exists=$false",
      "foreach ($p in $parts) { if ($p.TrimEnd('\\').ToLowerInvariant() -eq $target.TrimEnd('\\').ToLowerInvariant()) { $exists=$true; break } }",
      "if (-not $exists) {",
      "  if ([string]::IsNullOrWhiteSpace($current)) { $next=$target } else { $next=$current + ';' + $target }",
      "  [Environment]::SetEnvironmentVariable('PATH', $next, 'User')",
      "}",
      "Write-Output 'ok'"
    ].join('; ');
    const result = runCommand('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 15000 });
    if (result.ok) {
      refreshProcessPathFromSystem();
      process.env.PATH = appendPathEntry(process.env.PATH || '', dir);
      return { ok: true, manual: false, output: result.output, error: '' };
    }
    return { ok: false, manual: false, output: result.output, error: result.error || result.stderr || 'PATH 등록 실패' };
  }
  // On Unix we can't reliably auto-modify shell profile
  process.env.PATH = appendPathEntry(process.env.PATH || '', dir);
  return { ok: true, manual: true };
}

function registerPathForCli(cliId) {
  refreshProcessPathFromSystem();
  const installDir = detectInstallDir(cliId);
  if (!installDir) {
    return {
      ok: false,
      installDir: '',
      alreadyInPath: false,
      registered: false,
      manual: false,
      httpStatus: 404,
      message: '설치 경로를 찾을 수 없습니다. CLI가 설치되었는지 확인해 주세요.'
    };
  }

  if (isInPath(installDir)) {
    return {
      ok: true,
      installDir,
      alreadyInPath: true,
      registered: true,
      manual: false,
      httpStatus: 200,
      message: '이미 PATH에 등록되어 있습니다.'
    };
  }

  const result = addToPath(installDir);
  const manual = Boolean(result.manual);
  return {
    ok: Boolean(result.ok),
    installDir,
    alreadyInPath: false,
    registered: Boolean(result.ok),
    manual,
    httpStatus: result.ok ? 200 : 500,
    message: result.ok
      ? (manual ? `PATH에 추가했습니다: ${installDir} (새 터미널에서 반영됩니다)` : `PATH 등록 완료: ${installDir}`)
      : (result.error || 'PATH 등록 실패')
  };
}

app.post('/api/register-path', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  if (cliId !== 'node' && !CLI_CATALOG[cliId]) {
    return res.status(400).json({ status: 'error', message: '지원하지 않는 CLI' });
  }

  const pathResult = registerPathForCli(cliId);
  return res.status(pathResult.httpStatus).json({
    status: pathResult.ok ? 'success' : 'error',
    installDir: pathResult.installDir,
    alreadyInPath: pathResult.alreadyInPath,
    registered: pathResult.registered,
    manual: pathResult.manual,
    message: pathResult.message
  });
});

function launchLoginTerminal(cliId) {
  const loginSpec = CLI_LOGIN_COMMANDS[cliId];
  if (!loginSpec) return { ok: false, command: '', error: '로그인을 지원하지 않는 CLI입니다.' };
  const cmdLine = [loginSpec.command, ...loginSpec.args].join(' ');
  let result;
  if (process.platform === 'win32') {
    const script = `Start-Process powershell -ArgumentList '-NoExit','-Command',${escapePowerShellArg(cmdLine)}`;
    result = runCommand('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 5000 });
  } else if (process.platform === 'darwin') {
    result = runCommand(`open -a Terminal -n --args -l -c "${cmdLine}"`, [], { timeoutMs: 5000 });
  } else {
    result = runCommand(`x-terminal-emulator -e "${cmdLine}"`, [], { timeoutMs: 5000 });
  }
  if (!result || !result.ok) {
    return { ok: false, command: cmdLine, error: (result && (result.error || result.stderr)) || '로그인 터미널 실행 실패' };
  }
  return { ok: true, command: cmdLine, error: '' };
}

app.post('/api/launch-login', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  if (!supportsLoginCommand(cliId)) {
    return res.status(400).json({ status: 'error', cli: cliId, message: '로그인을 지원하지 않는 CLI입니다.' });
  }
  const launch = launchLoginTerminal(cliId);
  if (!launch.ok) {
    return res.status(500).json({ status: 'error', cli: cliId, message: launch.error, command: launch.command });
  }
  res.json({ status: 'success', cli: cliId, command: launch.command });
});

app.post('/api/post-install-login', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  if (!CLI_CATALOG[cliId]) {
    return res.status(400).json({ status: 'error', message: '지원하지 않는 CLI입니다.' });
  }

  const pathResult = registerPathForCli(cliId);
  if (!pathResult.ok) {
    return res.status(pathResult.httpStatus || 500).json({
      status: 'error',
      cli: cliId,
      path: pathResult,
      message: pathResult.message
    });
  }

  let login = {
    required: supportsLoginCommand(cliId),
    launched: false,
    command: '',
    message: '이 CLI는 추가 OAuth 로그인 단계가 없습니다.'
  };
  if (login.required) {
    const launch = launchLoginTerminal(cliId);
    login = {
      required: true,
      launched: launch.ok,
      command: launch.command,
      message: launch.ok
        ? '새 터미널에서 로그인 명령을 실행했습니다. OAuth 완료 후 [다음]을 눌러 상태를 확인하세요.'
        : (launch.error || '로그인 터미널 실행 실패')
    };
  }

  const cliStatus = detectCliStatus({ cliIds: [cliId] })[cliId] || null;
  res.json({
    status: login.required && !login.launched ? 'warning' : 'success',
    cli: cliId,
    path: pathResult,
    login,
    cliStatus
  });
});

app.post('/api/confirm-cli-login', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  if (!CLI_CATALOG[cliId]) {
    return res.status(400).json({ status: 'error', message: '지원하지 않는 CLI입니다.' });
  }

  refreshProcessPathFromSystem();
  const cliStatus = detectCliStatus({ cliIds: [cliId] })[cliId];
  if (!cliStatus) {
    return res.status(404).json({ status: 'error', message: 'CLI 상태를 찾을 수 없습니다.' });
  }

  const authenticated = ['ready', 'authenticated', 'auth_ok_no_response'].includes(cliStatus.status);
  res.json({
    status: 'success',
    cli: cliId,
    authenticated,
    cliStatus
  });
});

function findEnvMethod(cliId, methodId) {
  const spec = CLI_CATALOG[cliId];
  if (!spec || !spec.envSetup) return null;
  return (spec.envSetup.methods || []).find((m) => m.id === methodId) || null;
}

function presentEnvVars(method) {
  return (method.envVars || []).map((name) => ({ name, present: Boolean(process.env[name]) }));
}

function resolveMethodCommands(method, value) {
  const platform = currentPlatformKey();
  const blocks = (method.commands && method.commands[platform]) || [];
  return blocks.map((block) => ({
    id: block.id,
    label: block.label,
    command: renderCommandTemplate(block.template, value || '')
  }));
}

app.get('/api/env-setup', (req, res) => {
  const cliId = String(req.query.cli || '').toLowerCase();
  const spec = CLI_CATALOG[cliId];
  if (!spec || !spec.envSetup) {
    return res.status(404).json({ status: 'error', message: '지원하지 않는 CLI입니다.' });
  }
  const methods = spec.envSetup.methods.map((method) => ({
    id: method.id,
    type: method.type,
    label: method.label,
    description: method.description || '',
    configKey: method.configKey || '',
    envVars: presentEnvVars(method),
    needsValue: Boolean(method.needsValue),
    placeholder: method.placeholder || '',
    allowExecute: Boolean(method.allowExecute),
    commands: resolveMethodCommands(method, '')
  }));
  res.json({ status: 'success', cli: cliId, label: spec.label, platform: currentPlatformKey(), intro: spec.envSetup.intro, methods });
});

app.post('/api/env-setup/preview', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  const methodId = String(body.methodId || '');
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const method = findEnvMethod(cliId, methodId);
  if (!method) return res.status(404).json({ status: 'error', message: '설정 방식을 찾을 수 없습니다.' });
  if (method.needsValue && !value) return res.status(400).json({ status: 'error', message: '값이 필요합니다.' });
  res.json({ status: 'success', cli: cliId, methodId, commands: resolveMethodCommands(method, value) });
});

app.post('/api/env-setup/execute', (req, res) => {
  const body = req.body || {};
  const cliId = String(body.cli || '').toLowerCase();
  const methodId = String(body.methodId || '');
  const method = findEnvMethod(cliId, methodId);
  if (!method) return res.status(404).json({ status: 'error', message: '설정 방식을 찾을 수 없습니다.' });
  if (method.type !== 'command' || !method.allowExecute) {
    return res.status(400).json({ status: 'error', message: '보안상 API key는 자동 실행하지 않습니다. 명령을 복사해서 직접 실행해 주세요.' });
  }
  const result = runCommand(method.command.command, method.command.args || [], { timeoutMs: method.command.timeoutMs || 300000 });
  if (!result.ok) return res.status(500).json({ status: 'error', message: result.error || '명령 실행 실패' });
  res.json({ status: 'success', cli: cliId, methodId, output: result.output });
});

app.get('/api/model-discovery', async (req, res) => {
  const modelSpecs = readJsonFileWithBom(MODEL_SPECS_PATH, { models: {} });
  const config = readConfig();

  try {
    const discovered = await discoverModelsAllClis(modelSpecs, config);
    res.json({
      sources: discovered.sources,
      models: discovered.models,
      newModelsFound: discovered.newModelsFound,
      timestamp: discovered.timestamp
    });
  } catch (e) {
    res.status(500).json({
      status: 'error',
      message: '모델 디스커버리 조회에 실패했습니다.',
      details: String(e.message || e),
      timestamp: nowIsoString()
    });
  }
});

app.post('/api/model-specs/verify', async (req, res) => {
  const body = req.body || {};
  const autoUpdate = Boolean(body.autoUpdate);
  const mismatchAction = String(body.mismatchAction || 'warn');
  const modelSpecs = readJsonFileWithBom(MODEL_SPECS_PATH, { models: {} });
  const config = readConfig();

  let verification;
  try {
    verification = await verifyModelSpecs(modelSpecs, { autoUpdate, mismatchAction, config });
  } catch (e) {
    return res.status(500).json({
      status: 'error',
      message: 'model-specs 검증에 실패했습니다.',
      details: String(e.message || e)
    });
  }

  if (autoUpdate) {
    try {
      writeJsonFileWithBom(MODEL_SPECS_PATH, verification.updatedSpecs);
    } catch (e) {
      return res.status(500).json({ status: 'error', message: 'model-specs.json 자동 업데이트에 실패했습니다.', details: String(e.message || e) });
    }
  }

  res.json({
    status: 'success',
    autoUpdate,
    mismatchAction,
    mismatchCount: verification.mismatches.length,
    mismatches: verification.mismatches,
    discovered: verification.discovered
  });
});

app.post('/api/model-specs/probe/:modelId', (req, res) => {
  const modelId = String(req.params.modelId || '').trim();
  if (!modelId) {
    return res.status(400).json({ status: 'error', message: 'modelId가 필요합니다.' });
  }

  const body = req.body || {};
  const modelSpecs = readJsonFileWithBom(MODEL_SPECS_PATH, { version: '1.0', updatedAt: '', schema: {}, models: {} });
  const knownModel = (modelSpecs.models || {})[modelId];
  const systemCli = inferSystemCliFromModel(modelId, body.cli || (knownModel ? MODEL_CLI_TO_SYSTEM_CLI[knownModel.cli] : ''));
  const probe = probeModel(systemCli, modelId);
  const modelCli = SYSTEM_CLI_TO_MODEL_CLI[systemCli] || 'codex-cli';
  const now = nowIsoString();

  const merged = {
    provider: knownModel ? knownModel.provider : providerBySystemCli(systemCli),
    cli: knownModel ? knownModel.cli : modelCli,
    contextWindow: probe.contextWindow != null ? probe.contextWindow : (knownModel ? knownModel.contextWindow : null),
    maxOutputTokens: probe.maxOutputTokens != null ? probe.maxOutputTokens : (knownModel ? knownModel.maxOutputTokens : null),
    inputCostPer1M: knownModel ? knownModel.inputCostPer1M : null,
    outputCostPer1M: knownModel ? knownModel.outputCostPer1M : null,
    source: probe.ok ? 'probed' : (knownModel ? knownModel.source : 'unknown'),
    discoveredAt: now,
    notes: probe.ok
      ? `Probed via ${systemCli} CLI ping at ${now}.`
      : (knownModel ? knownModel.notes : `Probe failed via ${systemCli} at ${now}.`),
    lastVerifiedAt: now,
    verificationMethod: probe.ok ? 'api-probe' : 'ping-response',
    discoveryCommands: knownModel && knownModel.discoveryCommands
      ? knownModel.discoveryCommands
      : defaultDiscoveryCommandForModelCli(modelCli)
  };

  modelSpecs.models = modelSpecs.models || {};
  modelSpecs.models[modelId] = merged;
  modelSpecs.updatedAt = now.slice(0, 10);

  try {
    writeJsonFileWithBom(MODEL_SPECS_PATH, modelSpecs);
  } catch (e) {
    return res.status(500).json({ status: 'error', message: 'model-specs.json 업데이트에 실패했습니다.', details: String(e.message || e) });
  }

  return res.json({
    status: probe.ok ? 'success' : 'warning',
    modelId,
    systemCli,
    probe,
    updated: true
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT} | Node ${process.version} | platform=${process.platform} | env=${process.env.NODE_ENV || 'development'}`);
  console.log(`설정 위저드 주소: http://localhost:${PORT} (Electron 연결 대기 중)`);
});

process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
