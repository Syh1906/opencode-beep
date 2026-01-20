import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
let jsoncParse = null;
try {
  ({ parse: jsoncParse } = require("jsonc-parser"));
} catch {
  jsoncParse = null;
}

const EVENT_KEYS = ["sessionIdle", "permissionAsked", "questionAsked"];

const DEFAULT_CONFIG = {
  enabled: true,
  soundFile: "C:\\Windows\\Media\\Windows Notify.wav",
  repeat: 1,
  throttleMs: 2000,
  debugToast: false,
  events: {
    sessionIdle: true,
    permissionAsked: true,
    questionAsked: true,
  },
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findOpencodeDir(startDir) {
  let current = startDir;
  while (current) {
    const candidate = join(current, ".opencode");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function getConfigPathInDir(dir) {
  if (!dir) {
    return null;
  }
  const jsonc = join(dir, "beep.jsonc");
  if (existsSync(jsonc)) {
    return jsonc;
  }
  const json = join(dir, "beep.json");
  if (existsSync(json)) {
    return json;
  }
  return null;
}

function getGlobalConfigPath() {
  const configDir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
  return getConfigPathInDir(configDir);
}

function getProjectConfigPath(ctx) {
  if (!ctx?.directory) {
    return null;
  }
  const opencodeDir = findOpencodeDir(ctx.directory);
  if (opencodeDir) {
    const opencodeConfig = getConfigPathInDir(opencodeDir);
    if (opencodeConfig) {
      return opencodeConfig;
    }
    const projectRoot = dirname(opencodeDir);
    const rootConfig = getConfigPathInDir(projectRoot);
    if (rootConfig) {
      return rootConfig;
    }
  }
  return getConfigPathInDir(ctx.directory);
}

function parseConfig(raw) {
  if (jsoncParse) {
    const errors = [];
    const parsed = jsoncParse(raw, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length === 0 && isObject(parsed)) {
      return parsed;
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadConfigFile(configPath, logger) {
  if (!configPath) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    return parseConfig(raw);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      logger?.warn?.("beep config read failed, using defaults", { message: String(error.message || error) });
    }
    return null;
  }
}

function normalizeRepeat(value, fallback) {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, number);
}

function normalizeEventValue(value, fallbackEnabled) {
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  if (isObject(value)) {
    return {
      enabled: value.enabled ?? fallbackEnabled,
      soundFile: typeof value.soundFile === "string" ? value.soundFile : undefined,
      repeat: typeof value.repeat === "number" ? value.repeat : undefined,
      sources: Array.isArray(value.sources) ? value.sources.filter((source) => typeof source === "string") : undefined,
    };
  }
  return { enabled: fallbackEnabled };
}

function mergeEventConfig(baseValue, overrideValue, fallbackEnabled) {
  const baseNormalized = normalizeEventValue(baseValue, fallbackEnabled);
  if (overrideValue === undefined) {
    return baseNormalized;
  }
  if (typeof overrideValue === "boolean") {
    return { ...baseNormalized, enabled: overrideValue };
  }
  if (isObject(overrideValue)) {
    return {
      enabled: overrideValue.enabled ?? baseNormalized.enabled,
      soundFile: typeof overrideValue.soundFile === "string" ? overrideValue.soundFile : baseNormalized.soundFile,
      repeat: typeof overrideValue.repeat === "number" ? overrideValue.repeat : baseNormalized.repeat,
      sources: Array.isArray(overrideValue.sources)
        ? overrideValue.sources.filter((source) => typeof source === "string")
        : baseNormalized.sources,
    };
  }
  return baseNormalized;
}

function mergeConfig(base, override) {
  if (!isObject(override)) {
    return base;
  }
  const merged = {
    ...base,
    events: { ...base.events },
  };
  if (typeof override.enabled === "boolean") {
    merged.enabled = override.enabled;
  }
  if (typeof override.soundFile === "string") {
    merged.soundFile = override.soundFile;
  }
  if (typeof override.repeat === "number") {
    merged.repeat = override.repeat;
  }
  if (typeof override.throttleMs === "number") {
    merged.throttleMs = override.throttleMs;
  }
  if (typeof override.debugToast === "boolean") {
    merged.debugToast = override.debugToast;
  }
  if (isObject(override.events)) {
    for (const key of EVENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(override.events, key)) {
        merged.events[key] = mergeEventConfig(merged.events[key], override.events[key], DEFAULT_CONFIG.events[key]);
      }
    }
  }
  return merged;
}

function normalizeConfig(config) {
  const normalized = { ...config, events: {} };
  for (const key of EVENT_KEYS) {
    normalized.events[key] = mergeEventConfig(config.events?.[key], undefined, DEFAULT_CONFIG.events[key]);
  }
  return normalized;
}

function readConfig(ctx, logger) {
  let config = { ...DEFAULT_CONFIG };
  const globalPath = getGlobalConfigPath();
  const projectPath = getProjectConfigPath(ctx);
  const globalConfig = loadConfigFile(globalPath, logger);
  if (globalConfig) {
    config = mergeConfig(config, globalConfig);
  }
  const projectConfig = loadConfigFile(projectPath, logger);
  if (projectConfig) {
    config = mergeConfig(config, projectConfig);
  }
  return { config: normalizeConfig(config), paths: { global: globalPath, project: projectPath } };
}

async function showDebugToast(ctx, config, message, variant = "info") {
  if (!config.debugToast) {
    return;
  }
  const showToast = ctx.client?.tui?.showToast;
  if (!showToast) {
    return;
  }
  try {
    await showToast({
      query: { directory: ctx.directory },
      body: { title: "beep", message, variant, duration: 3000 },
    });
  } catch (error) {
    ctx.client?.logger?.warn?.("beep debug toast failed", { message: String(error?.message || error) });
  }
}

function createThrottle() {
  let lastBeepAt = 0;
  return (throttleMs) => {
    const windowMs = typeof throttleMs === "number" ? Math.max(0, throttleMs) : 0;
    const now = Date.now();
    const remainingMs = Math.max(0, windowMs - (now - lastBeepAt));
    if (remainingMs > 0) {
      return { allowed: false, remainingMs };
    }
    lastBeepAt = now;
    return { allowed: true, remainingMs: 0 };
  };
}

function createSessionIdleTracker() {
  const lastStatusBySession = new Map();
  return {
    recordStatus(sessionId, statusType) {
      const last = lastStatusBySession.get(sessionId);
      lastStatusBySession.set(sessionId, statusType);
      return last;
    },
    lastStatus(sessionId) {
      return lastStatusBySession.get(sessionId);
    },
    setIdle(sessionId) {
      lastStatusBySession.set(sessionId, "idle");
    },
  };
}

function formatDetails(details) {
  if (!details) {
    return "";
  }
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function resolveEventSettings(config, eventKey) {
  const eventConfig = normalizeEventValue(config.events?.[eventKey], DEFAULT_CONFIG.events[eventKey]);
  const fallbackSound = typeof config.soundFile === "string" ? config.soundFile : DEFAULT_CONFIG.soundFile;
  const soundFile = typeof eventConfig.soundFile === "string" ? eventConfig.soundFile : fallbackSound;
  const repeat = normalizeRepeat(eventConfig.repeat, normalizeRepeat(config.repeat, DEFAULT_CONFIG.repeat));
  return {
    enabled: eventConfig.enabled !== false,
    soundFile,
    repeat,
    sources: eventConfig.sources,
  };
}

async function playSound(ctx, settings, logger, config) {
  const shell = ctx.$.nothrow();
  const escapedPath = settings.soundFile.replace(/'/g, "''");
  const repeat = normalizeRepeat(settings.repeat, DEFAULT_CONFIG.repeat);
  const command = "powershell";
  const script =
    repeat === 1
      ? `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`
      : `1..${repeat} | ForEach-Object { (New-Object Media.SoundPlayer '${escapedPath}').PlaySync() }`;
  const args = ["-NoProfile", "-Command", script];
  const { exitCode, stderr } = await shell`${command} ${args}`;
  if (exitCode !== 0) {
    logger?.warn?.("beep playback failed", { exitCode, stderr: stderr?.toString?.() ?? String(stderr) });
    await showDebugToast(ctx, config, `beep failed (exit=${exitCode})`, "error");
  }
}

const plugin = async (ctx) => {
  const { config } = readConfig(ctx, ctx.client?.logger);
  const allowBeep = createThrottle();
  const sessionIdle = createSessionIdleTracker();

  const handleBeep = async (eventKey, details) => {
    if (!config.enabled) {
      return;
    }
    const settings = resolveEventSettings(config, eventKey);
    if (!settings.enabled) {
      return;
    }
    if (Array.isArray(settings.sources) && !settings.sources.includes(details?.source)) {
      return;
    }
    const { allowed, remainingMs } = allowBeep(config.throttleMs);
    if (!allowed) {
      await showDebugToast(
        ctx,
        config,
        `beep throttled (${remainingMs}ms): ${eventKey}${formatDetails(details)}`,
        "warning"
      );
      return;
    }
    const soundLabel = basename(settings.soundFile);
    await showDebugToast(
      ctx,
      config,
      `beep: ${eventKey} (${soundLabel}, x${settings.repeat})${formatDetails(details)}`,
      "info"
    );
    await playSound(ctx, settings, ctx.client?.logger, config);
  };

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const statusType = event.properties?.status?.type;
        const sessionId = event.properties?.sessionID;
        if (!statusType || !sessionId) {
          return;
        }
        const lastStatus = sessionIdle.recordStatus(sessionId, statusType);
        if (statusType === "idle" && (lastStatus === "busy" || lastStatus === "retry")) {
          await handleBeep("sessionIdle", { source: "session.status", sessionId, prev: lastStatus });
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) {
          return;
        }
        const lastStatus = sessionIdle.lastStatus(sessionId);
        if (lastStatus === "busy" || lastStatus === "retry") {
          await handleBeep("sessionIdle", { source: "session.idle", sessionId, prev: lastStatus });
        }
        sessionIdle.setIdle(sessionId);
        return;
      }

      if (event.type === "permission.asked") {
        await handleBeep("permissionAsked", { source: "permission.asked", sessionId: event.properties?.sessionID });
        return;
      }

      if (event.type === "question.asked") {
        await handleBeep("questionAsked", { source: "question.asked", sessionId: event.properties?.sessionID });
      }
    },
    "permission.ask": async (input, output) => {
      if (output?.status !== "ask") {
        return;
      }
      await handleBeep("permissionAsked", { source: "permission.ask", sessionId: input.sessionID, permission: input.type });
    },
    "tool.execute.before": async (input) => {
      if (input.tool !== "question") {
        return;
      }
      await handleBeep("questionAsked", { source: "question tool", sessionId: input.sessionID });
    },
  };
};

export default plugin;
