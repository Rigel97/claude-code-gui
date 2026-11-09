const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');

const STORE_KEY = 'runtimeConfiguration';
const ALLOWED_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION',
  'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CA_BUNDLE',
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SDK_LOAD_CONFIG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'PATH', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_AUTOUPDATE', 'CLAUDE_CODE_DISABLE_TELEMETRY',
  'CLAUDE_BASH_NO_LOGIN', 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
]);

function endpoint(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return null; }
}
function secretKey(key, value) {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|HEADERS/i.test(key)
    || (/PROXY|URL/i.test(key) && /:\/\/|@|\?/.test(value));
}
function validateExecutable(executable, platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  if (typeof executable !== 'string' || executable.includes('\0') || !paths.isAbsolute(executable)) {
    throw new Error('Executable must be an absolute file path');
  }
  try {
    if (!fs.statSync(executable).isFile()) throw new Error();
    fs.accessSync(executable, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  } catch { throw new Error('Claude executable not found or not executable'); }
}

class ClaudeRuntime {
  #volatile = null;
  #queue = Promise.resolve();

  constructor({ store, safeStorage, home = os.homedir(), platform = process.platform, baseEnv = process.env, execFile = childProcess.execFile }) {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
      throw new Error('A dedicated runtime configuration store is required');
    }
    this.store = store;
    this.safeStorage = safeStorage;
    this.home = home;
    this.platform = platform;
    this.baseEnv = { ...baseEnv };
    this.execFile = execFile;
  }

  #encryptionAvailable() {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && this.safeStorage?.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  #read() {
    if (this.#volatile) return structuredClone(this.#volatile);
    try {
      const config = this.store.get(STORE_KEY);
      if (config === undefined) return { executable: null, environment: {}, removedKeys: [], versionFingerprint: 'default', lastChangedAt: null, persisted: true };
      if (!config || config.schemaVersion !== 1 || typeof config.versionFingerprint !== 'string'
        || Object.keys(config).some(key => !['schemaVersion', 'executable', 'encryptedEnvironment', 'versionFingerprint', 'lastChangedAt'].includes(key))
        || (config.lastChangedAt !== null && (typeof config.lastChangedAt !== 'string' || !Number.isFinite(Date.parse(config.lastChangedAt))))) throw new Error();
      let data = { environment: {}, removedKeys: [] };
      if (config.encryptedEnvironment !== null) {
        if (!this.#encryptionAvailable() || typeof config.encryptedEnvironment !== 'string'
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(config.encryptedEnvironment)
          || !config.encryptedEnvironment) throw new Error();
        data = JSON.parse(this.safeStorage.decryptString(Buffer.from(config.encryptedEnvironment, 'base64')));
      }
      if (!data || Object.keys(data).some(key => !['environment', 'removedKeys'].includes(key))
        || !data.environment || typeof data.environment !== 'object' || Array.isArray(data.environment)
        || !Array.isArray(data.removedKeys)) throw new Error();
      for (const [key, value] of Object.entries(data.environment)) {
        if (!ALLOWED_KEYS.has(key) || typeof value !== 'string' || value.includes('\0')) throw new Error();
      }
      if (data.removedKeys.some(key => !ALLOWED_KEYS.has(key) || Object.hasOwn(data.environment, key))
        || new Set(data.removedKeys).size !== data.removedKeys.length) throw new Error();
      if (config.executable !== null && (typeof config.executable !== 'string' || config.executable.includes('\0'))) throw new Error();
      return { executable: config.executable, environment: data.environment, removedKeys: data.removedKeys, versionFingerprint: config.versionFingerprint,
        lastChangedAt: config.lastChangedAt, persisted: true };
    } catch { throw new Error('Runtime configuration could not be read or decrypted; existing configuration was not changed'); }
  }

  #summary(state) {
    return { executable: state.executable, environmentKeys: Object.keys(state.environment).sort(),
      removedKeys: [...state.removedKeys].sort(),
      secretCount: Object.entries(state.environment).filter(([key, value]) => secretKey(key, value)).length,
      encryptionAvailable: this.#encryptionAvailable(), endpoint: endpoint(state.environment.ANTHROPIC_BASE_URL),
      versionFingerprint: state.versionFingerprint, lastChangedAt: state.lastChangedAt, persisted: state.persisted };
  }

  get() { return this.#summary(this.#read()); }

  set(options, { persist = true } = {}) {
    let snapshot;
    try { snapshot = structuredClone(options); }
    catch { return Promise.reject(new Error('Invalid runtime update')); }
    const operation = this.#queue.then(() => this.#set(snapshot, persist));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  #run(executable, args, env, maxBuffer) {
    return new Promise((resolve, reject) => {
      try {
        const child = this.execFile(executable, args, { env, shell: false, windowsHide: true,
          timeout: 10000, maxBuffer, encoding: 'utf8' }, (error, stdout) => {
          if (error || typeof stdout !== 'string' || Buffer.byteLength(stdout) > maxBuffer) reject(new Error('Runtime process failed'));
          else resolve(stdout);
        });
        child?.stdin?.end();
      } catch { reject(new Error('Runtime process failed')); }
    });
  }

  async #importEnvironment() {
    if (this.platform === 'win32') throw new Error('Login environment import is unavailable on this platform');
    const shell = process.env.SHELL || '/bin/zsh';
    validateExecutable(shell, this.platform);
    try {
      const output = await this.#run(shell, ['-ilc', '/usr/bin/env -0'], { ...this.baseEnv }, 2 * 1024 * 1024);
      if (!output.endsWith('\0')) throw new Error();
      const environment = {};
      for (const entry of output.slice(0, -1).split('\0')) {
        const separator = entry.indexOf('=');
        if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, separator))) throw new Error();
        const key = entry.slice(0, separator);
        if (!ALLOWED_KEYS.has(key)) continue;
        if (Object.hasOwn(environment, key)) throw new Error();
        environment[key] = entry.slice(separator + 1);
      }
      return environment;
    } catch { throw new Error('Login environment import failed; no configuration was applied'); }
  }

  async #set(options, persist) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['executable', 'environmentUpdates', 'importLoginEnvironment'].includes(key))
      || typeof persist !== 'boolean') throw new Error('Invalid runtime update');
    if (options.importLoginEnvironment !== undefined && typeof options.importLoginEnvironment !== 'boolean') throw new Error('Invalid login environment consent');
    const updates = options.environmentUpdates === undefined ? [] : options.environmentUpdates;
    if (!Array.isArray(updates)) throw new Error('Invalid environment updates');
    const seen = new Set();
    for (const update of updates) {
      if (!update || typeof update !== 'object' || Array.isArray(update)
        || Object.keys(update).some(key => !['key', 'value', 'remove'].includes(key))
        || !ALLOWED_KEYS.has(update.key) || seen.has(update.key)
        || (update.remove !== undefined && typeof update.remove !== 'boolean')
        || (update.remove === true ? update.value !== undefined : typeof update.value !== 'string' || update.value.includes('\0'))) {
        throw new Error('Environment update is invalid or not allowlisted');
      }
      seen.add(update.key);
    }
    if (options.executable !== undefined && options.executable !== null) validateExecutable(options.executable, this.platform);
    const previous = this.#read();
    const next = structuredClone(previous);
    if (options.executable !== undefined) next.executable = options.executable;
    if (options.importLoginEnvironment === true) {
      const imported = await this.#importEnvironment();
      Object.assign(next.environment, imported);
      next.removedKeys = next.removedKeys.filter(key => !Object.hasOwn(imported, key));
    }
    for (const { key, value, remove } of updates) {
      if (remove) {
        delete next.environment[key];
        if (!next.removedKeys.includes(key)) next.removedKeys.push(key);
      } else {
        next.environment[key] = value;
        next.removedKeys = next.removedKeys.filter(item => item !== key);
      }
    }
    next.environment = Object.fromEntries(Object.entries(next.environment).sort(([a], [b]) => a.localeCompare(b)));
    next.removedKeys.sort();
    const changed = JSON.stringify([previous.executable, previous.environment, previous.removedKeys])
      !== JSON.stringify([next.executable, next.environment, next.removedKeys]);
    if (changed) {
      next.versionFingerprint = randomUUID();
      next.lastChangedAt = new Date().toISOString();
    }
    next.persisted = persist;
    if (!changed && previous.persisted === persist) return this.#summary(previous);
    if (persist) {
      const hasEnvironment = Object.keys(next.environment).length || next.removedKeys.length;
      if (hasEnvironment && !this.#encryptionAvailable()) throw new Error('Secure encryption unavailable; use explicit persist=false for volatile configuration');
      let encryptedEnvironment = null;
      try {
        if (hasEnvironment) encryptedEnvironment = this.safeStorage.encryptString(JSON.stringify({ environment: next.environment, removedKeys: next.removedKeys })).toString('base64');
        this.store.set(STORE_KEY, { schemaVersion: 1, executable: next.executable, encryptedEnvironment,
          versionFingerprint: next.versionFingerprint, lastChangedAt: next.lastChangedAt });
      } catch { throw new Error('Runtime configuration could not be encrypted or saved; existing configuration was not changed'); }
      this.#volatile = null;
    } else this.#volatile = next;
    return this.#summary(next);
  }

  async diagnostics() {
    const summary = this.get();
    let runtime;
    try { runtime = await this.resolve(); }
    catch { return { ...summary, version: null, error: 'Claude executable not found or not executable' }; }
    try {
      const output = await this.#run(runtime.executable, ['--version'], runtime.env, 65536);
      const version = output.match(/^\s*(?:v)?(\d{1,6}\.\d{1,6}\.\d{1,6})(?=\s|$)/)?.[1];
      if (!version) throw new Error();
      return { ...summary, executable: runtime.executable, version, error: null };
    } catch {
      return { ...summary, executable: runtime.executable, version: null, error: 'Claude version check failed or timed out' };
    }
  }

  async resolve() {
    const state = this.#read();
    const env = { ...this.baseEnv, ...state.environment };
    for (const key of state.removedKeys) delete env[key];
    const windows = this.platform === 'win32';
    const pathsApi = windows ? path.win32 : path;
    const delimiter = windows ? ';' : ':';
    const additions = windows ? [pathsApi.join(this.home, '.local', 'bin')]
      : [path.join(this.home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
    const paths = [...new Set([...(env.PATH || '').split(delimiter).filter(Boolean), ...additions])];
    env.PATH = paths.join(delimiter);
    if (state.executable) {
      validateExecutable(state.executable, this.platform);
      return { executable: state.executable, env };
    }
    for (const directory of paths) {
      for (const name of windows ? ['claude.exe', 'claude.com'] : ['claude']) {
        const executable = pathsApi.join(directory, name);
        try {
          validateExecutable(executable, this.platform);
          return { executable, env };
        } catch { /* Continue to the next installation location; never interpret shell commands. */ }
      }
    }
    throw new Error('Claude executable not found or not executable');
  }
}

module.exports = { ClaudeRuntime };
