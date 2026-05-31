// Platform-agnostic helpers shared with the runtime control surface.
//
// Most of this file is identical to integrations/feishu-bridge/src/lib.mjs:
// command parsing, allowlist checks, message splitting, runtime-error
// formatting, and turn-state helpers are not platform-specific. Only the
// identity/transport pieces (incomingIdentity, stripGroupPrefix, the config
// validator, and helpText) are adapted for Telegram's update shape and env
// keys. Keeping this self-contained means the bridge deploys as one directory
// with no cross-package imports.

// Brand migration: read a runtime/agent var by suffix, preferring CODEWHALE_*
// and falling back to the legacy DEEPSEEK_* name so existing env files keep
// working. Telegram transport vars (TELEGRAM_*) don't go through this.
export function pickEnv(env, suffix) {
  return env[`CODEWHALE_${suffix}`] ?? env[`DEEPSEEK_${suffix}`];
}

export function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBool(raw, fallback = false) {
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

export function parseEnvText(raw) {
  const env = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    let value = normalized.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function cleanEnvValue(value) {
  return String(value ?? "").trim();
}

export function isPlaceholderValue(value) {
  const normalized = cleanEnvValue(value).toLowerCase();
  return (
    !normalized ||
    normalized.includes("replace-with") ||
    normalized.includes("xxxxxxxx") ||
    normalized === "changeme"
  );
}

// Telegram delivers a `message` object directly (no JSON-wrapped content like
// Feishu), so the bridge reads `message.text` straight through.
export function incomingIdentity(message) {
  const chat = message?.chat || {};
  const from = message?.from || {};
  return {
    chatId: chat.id != null ? String(chat.id) : "",
    messageId: message?.message_id != null ? String(message.message_id) : "",
    // "private" is the DM equivalent of Feishu's "p2p". Groups are
    // "group"/"supergroup"; channels are "channel".
    chatType: chat.type || "",
    messageType: typeof message?.text === "string" ? "text" : "other",
    userId: from.id != null ? String(from.id) : "",
    username: from.username || "",
    // Forum topics in supergroups carry a thread id; replies must echo it back
    // so the bot answers inside the same topic instead of the General topic.
    topicId: message?.message_thread_id != null ? message.message_thread_id : null,
    text: typeof message?.text === "string" ? message.text : ""
  };
}

export function isAllowed(identity, allowlist, allowUnlisted = false) {
  if (allowUnlisted) return true;
  const allowed = new Set(allowlist);
  return [identity.chatId, identity.userId]
    .filter(Boolean)
    .some((id) => allowed.has(id));
}

export function pairingRefusalText(identity) {
  return [
    "This chat is not in CODEWHALE_CHAT_ALLOWLIST.",
    `chat_id=${identity.chatId}`,
    identity.userId ? `user_id=${identity.userId}` : "",
    identity.username ? `username=@${identity.username}` : "",
    "",
    "Add chat_id (or user_id) to CODEWHALE_CHAT_ALLOWLIST and restart the bridge."
  ]
    .filter(Boolean)
    .join("\n");
}

export function stripGroupPrefix(text, { chatType, requirePrefix, prefix }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { accepted: false, text: "" };
  if (!requirePrefix || chatType === "private") {
    return { accepted: true, text: trimmed };
  }
  const marker = prefix || "/ds";
  if (trimmed === marker) return { accepted: true, text: "/help" };
  if (trimmed.startsWith(`${marker} `)) {
    return { accepted: true, text: trimmed.slice(marker.length).trim() };
  }
  return { accepted: false, text: "" };
}

export function parseCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return { name: "prompt", args: trimmed };
  const [head, ...rest] = trimmed.split(/\s+/);
  // Telegram appends @botname to commands in groups (e.g. /status@my_bot).
  // Strip it so commands work the same in DMs and groups.
  const name = head.slice(1).split("@")[0].toLowerCase();
  return {
    name,
    args: rest.join(" ").trim()
  };
}

export function parseApprovalDecisionArgs(args) {
  const parts = String(args || "")
    .split(/\s+/)
    .filter(Boolean);
  return {
    approvalId: parts[0] || "",
    remember: parts.slice(1).includes("remember")
  };
}

export function commandAction(command) {
  switch (command.name) {
    case "start":
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "threads":
      return { kind: "threads" };
    case "new":
      return { kind: "new_thread" };
    case "resume":
      return { kind: "resume", threadId: command.args };
    case "interrupt":
      return { kind: "interrupt" };
    case "compact":
      return { kind: "compact" };
    case "allow":
      return { kind: "approval", decision: "allow", ...parseApprovalDecisionArgs(command.args) };
    case "deny":
      return { kind: "approval", decision: "deny", ...parseApprovalDecisionArgs(command.args) };
    case "prompt":
      return { kind: "prompt", prompt: command.args };
    default:
      return {
        kind: "prompt",
        prompt: `/${command.name}${command.args ? ` ${command.args}` : ""}`
      };
  }
}

export function splitMessage(text, maxChars = 3900) {
  const value = String(text || "");
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value ? [value] : [];
  const chunks = [];
  let cursor = 0;
  while (cursor < chars.length) {
    chunks.push(chars.slice(cursor, cursor + maxChars).join(""));
    cursor += maxChars;
  }
  return chunks;
}

export function compactRuntimeError(status, body) {
  const message =
    body?.error?.message ||
    body?.message ||
    (typeof body === "string" ? body : JSON.stringify(body));
  return `Runtime API request failed (${status}): ${message}`;
}

export function latestRunningTurn(detail) {
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (["queued", "in_progress"].includes(turn?.status)) return turn;
  }
  return null;
}

export function activeTurnBlock(detail, state = {}) {
  const runningTurn = latestRunningTurn(detail);
  if (!runningTurn) return null;
  return {
    turnId: runningTurn.id || state.activeTurnId || "",
    message: `Thread already has active turn ${
      runningTurn.id || state.activeTurnId || "(unknown)"
    }. Wait for it to finish or send /interrupt.`
  };
}

export function validateBridgeConfig(env, options = {}) {
  const runtimeEnv = options.runtimeEnv || null;
  const workspaceRoot = options.workspaceRoot || "";
  const errors = [];
  const warnings = [];
  const info = [];
  const add = (list, code, message) => list.push({ code, message });

  // Telegram transport vars keep their exact names.
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_THREAD_MAP_PATH"]) {
    const value = cleanEnvValue(env[key]);
    if (!value) {
      add(errors, "missing_required", `${key} is required`);
    } else if (isPlaceholderValue(value)) {
      add(errors, "placeholder_value", `${key} still contains a placeholder value`);
    }
  }
  // Runtime/agent vars: prefer CODEWHALE_*, accept legacy DEEPSEEK_*.
  for (const suffix of ["RUNTIME_URL", "RUNTIME_TOKEN", "WORKSPACE"]) {
    const value = cleanEnvValue(pickEnv(env, suffix));
    const label = `CODEWHALE_${suffix}`;
    if (!value) {
      add(errors, "missing_required", `${label} (or legacy DEEPSEEK_${suffix}) is required`);
    } else if (isPlaceholderValue(value)) {
      add(errors, "placeholder_value", `${label} still contains a placeholder value`);
    }
  }

  // Telegram bot tokens look like "<digits>:<35-char base64ish>". A loose
  // shape check catches the common "pasted the wrong thing" mistake without
  // being brittle about Telegram's exact format.
  const token = cleanEnvValue(env.TELEGRAM_BOT_TOKEN);
  if (token && !isPlaceholderValue(token) && !/^\d{6,}:[\w-]{30,}$/.test(token)) {
    add(warnings, "token_shape", "TELEGRAM_BOT_TOKEN does not look like a BotFather token (<id>:<secret>)");
  }

  const apiBase = cleanEnvValue(env.TELEGRAM_API_BASE || "https://api.telegram.org");
  try {
    const parsed = new URL(apiBase);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      add(errors, "invalid_api_base", "TELEGRAM_API_BASE must use http or https");
    }
  } catch {
    add(errors, "invalid_api_base", "TELEGRAM_API_BASE is not a valid URL");
  }

  const runtimeUrl = cleanEnvValue(pickEnv(env, "RUNTIME_URL") || "http://127.0.0.1:7878");
  try {
    const parsed = new URL(runtimeUrl);
    const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      add(errors, "invalid_runtime_url", "CODEWHALE_RUNTIME_URL must use http or https");
    }
    if (!localHosts.has(parsed.hostname)) {
      add(
        errors,
        "remote_runtime_url",
        "CODEWHALE_RUNTIME_URL must point at localhost; keep the runtime bound to 127.0.0.1"
      );
    }
  } catch {
    add(errors, "invalid_runtime_url", "CODEWHALE_RUNTIME_URL is not a valid URL");
  }

  const workspace = cleanEnvValue(pickEnv(env, "WORKSPACE"));
  if (workspace && !workspace.startsWith("/")) {
    add(errors, "relative_workspace", "CODEWHALE_WORKSPACE must be an absolute path");
  }
  if (
    workspace &&
    workspaceRoot &&
    workspace !== workspaceRoot &&
    !workspace.startsWith(`${workspaceRoot}/`)
  ) {
    add(warnings, "workspace_root", `CODEWHALE_WORKSPACE is outside ${workspaceRoot}`);
  }

  const threadMapPath = cleanEnvValue(env.TELEGRAM_THREAD_MAP_PATH);
  if (threadMapPath && !threadMapPath.startsWith("/")) {
    add(errors, "relative_thread_map", "TELEGRAM_THREAD_MAP_PATH must be an absolute path");
  }

  const allowGroups = parseBool(env.TELEGRAM_ALLOW_GROUPS, false);
  const requirePrefix = parseBool(env.TELEGRAM_REQUIRE_PREFIX_IN_GROUP, true);
  const allowUnlisted = parseBool(pickEnv(env, "ALLOW_UNLISTED"), false);
  const allowlist = parseList(pickEnv(env, "CHAT_ALLOWLIST"));

  if (!allowlist.length && allowUnlisted) {
    add(warnings, "pairing_mode_open", "CODEWHALE_ALLOW_UNLISTED=true leaves the bot open to anyone who finds it");
  } else if (!allowlist.length) {
    add(warnings, "not_paired", "CODEWHALE_CHAT_ALLOWLIST is empty; all chats will be refused");
  }
  if (allowGroups && allowUnlisted) {
    add(errors, "open_group_control", "Group control cannot be enabled while unlisted chats are allowed");
  }
  if (allowGroups && !requirePrefix) {
    add(warnings, "group_without_prefix", "Group control is enabled without requiring TELEGRAM_GROUP_PREFIX");
  }
  if (!allowGroups) {
    add(info, "dm_only", "Direct-message control is enabled; group chats are disabled");
  }

  const maxReplyChars = Number(env.TELEGRAM_MAX_REPLY_CHARS || 3900);
  if (!Number.isFinite(maxReplyChars) || maxReplyChars < 100) {
    add(errors, "invalid_max_reply_chars", "TELEGRAM_MAX_REPLY_CHARS must be at least 100");
  } else if (maxReplyChars > 4096) {
    add(errors, "max_reply_chars_over_limit", "TELEGRAM_MAX_REPLY_CHARS must be <= 4096 (Telegram's hard limit)");
  }
  const pollTimeout = Number(env.TELEGRAM_POLL_TIMEOUT_SEC || 50);
  if (!Number.isFinite(pollTimeout) || pollTimeout < 0 || pollTimeout > 600) {
    add(errors, "invalid_poll_timeout", "TELEGRAM_POLL_TIMEOUT_SEC must be between 0 and 600");
  }
  const turnTimeoutMs = Number(pickEnv(env, "TURN_TIMEOUT_MS") || 900000);
  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs < 1000) {
    add(errors, "invalid_turn_timeout", "CODEWHALE_TURN_TIMEOUT_MS must be at least 1000");
  }

  if (runtimeEnv) {
    const runtimeToken = cleanEnvValue(pickEnv(runtimeEnv, "RUNTIME_TOKEN"));
    const bridgeToken = cleanEnvValue(pickEnv(env, "RUNTIME_TOKEN"));
    if (!runtimeToken) {
      add(errors, "missing_runtime_token", "runtime.env is missing CODEWHALE_RUNTIME_TOKEN");
    } else if (isPlaceholderValue(runtimeToken)) {
      add(errors, "placeholder_runtime_token", "runtime.env CODEWHALE_RUNTIME_TOKEN is still a placeholder");
    } else if (bridgeToken && bridgeToken !== runtimeToken) {
      add(errors, "token_mismatch", "Runtime and bridge CODEWHALE_RUNTIME_TOKEN values do not match");
    }

    // Provider-agnostic: the runtime resolves its provider from CODEWHALE_PROVIDER
    // and that provider's own key var (OPENROUTER_API_KEY, DEEPSEEK_API_KEY, ...),
    // so just confirm some provider key is present rather than assuming DeepSeek.
    const apiKey = Object.keys(runtimeEnv)
      .filter((k) => k.endsWith("_API_KEY"))
      .map((k) => cleanEnvValue(runtimeEnv[k]))
      .find(Boolean);
    if (!apiKey) {
      add(warnings, "missing_api_key", "runtime.env has no provider *_API_KEY (e.g. OPENROUTER_API_KEY / DEEPSEEK_API_KEY)");
    } else if (isPlaceholderValue(apiKey)) {
      add(warnings, "placeholder_api_key", "runtime.env provider API key is still a placeholder");
    }

    const runtimePort = Number(pickEnv(runtimeEnv, "RUNTIME_PORT") || 7878);
    if (!Number.isInteger(runtimePort) || runtimePort <= 0 || runtimePort > 65535) {
      add(errors, "invalid_runtime_port", "CODEWHALE_RUNTIME_PORT must be a valid TCP port");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info
  };
}

export function formatValidationReport(result) {
  const lines = ["Telegram bridge config validation"];
  for (const item of result.errors) lines.push(`[fail] ${item.message}`);
  for (const item of result.warnings) lines.push(`[warn] ${item.message}`);
  for (const item of result.info) lines.push(`[info] ${item.message}`);
  if (result.ok) lines.push("[ok] No blocking config errors found");
  return lines.join("\n");
}

export function helpText() {
  return [
    "CodeWhale Telegram bridge commands:",
    "/help - show this help",
    "/status - runtime and workspace status",
    "/threads - recent runtime threads",
    "/new - create a new thread for this chat",
    "/resume <thread_id> - bind this chat to an existing thread",
    "/interrupt - interrupt the active turn",
    "/compact - compact the current thread",
    "/allow <approval_id> [remember] - approve a pending tool call",
    "/deny <approval_id> - deny a pending tool call",
    "",
    "Anything else is sent to CodeWhale as a prompt."
  ].join("\n");
}
