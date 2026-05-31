import fs from "node:fs/promises";
import path from "node:path";

import {
  activeTurnBlock,
  commandAction,
  compactRuntimeError,
  helpText,
  incomingIdentity,
  isAllowed,
  latestRunningTurn,
  pairingRefusalText,
  parseApprovalDecisionArgs,
  parseBool,
  parseCommand,
  parseList,
  splitMessage,
  stripGroupPrefix
} from "./lib.mjs";

// Persistent per-chat thread mapping plus the Telegram getUpdates offset and a
// short ring buffer of recently handled message ids (de-dup across restarts).
// Identical structure to the Feishu bridge's store, with one extra field:
// `tgOffset`, so a restart resumes from the next un-acked update.
class ThreadStore {
  static async open(filePath) {
    const store = new ThreadStore(filePath);
    await store.load();
    return store;
  }

  constructor(filePath) {
    this.filePath = filePath;
    this.data = { chats: {}, messages: [], tgOffset: 0 };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw);
      if (!this.data.chats) this.data.chats = {};
      if (!Array.isArray(this.data.messages)) this.data.messages = [];
      if (!Number.isFinite(this.data.tgOffset)) this.data.tgOffset = 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  getOffset() {
    return Number(this.data.tgOffset || 0);
  }

  async setOffset(offset) {
    this.data.tgOffset = Number(offset || 0);
    await this.save();
  }

  async recordMessage(messageId) {
    if (!messageId) return false;
    if (!Array.isArray(this.data.messages)) this.data.messages = [];
    if (this.data.messages.includes(messageId)) return true;
    this.data.messages.push(messageId);
    this.data.messages = this.data.messages.slice(-200);
    await this.save();
    return false;
  }

  async getChat(chatId) {
    return this.data.chats[chatId] || null;
  }

  listChats() {
    return Object.entries(this.data.chats || {});
  }

  async setChat(chatId, state) {
    this.data.chats[chatId] = state;
    await this.save();
    return state;
  }

  async patchChat(chatId, patch) {
    const current = this.data.chats[chatId] || {};
    this.data.chats[chatId] = { ...current, ...patch };
    await this.save();
    return this.data.chats[chatId];
  }

  async save() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}

// Brand migration: prefer CODEWHALE_*, fall back to the legacy DEEPSEEK_*
// names so existing deployments keep working unchanged. Only the runtime/agent
// vars move; Telegram transport vars (TELEGRAM_*) are unaffected.
function cwEnv(suffix) {
  return process.env[`CODEWHALE_${suffix}`] ?? process.env[`DEEPSEEK_${suffix}`];
}

function requiredCwEnv(suffix) {
  const value = cwEnv(suffix);
  if (!value || !value.trim()) {
    throw new Error(`CODEWHALE_${suffix} (or legacy DEEPSEEK_${suffix}) is required`);
  }
  return value.trim();
}

const config = {
  botToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
  apiBase: (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
  runtimeUrl: (cwEnv("RUNTIME_URL") || "http://127.0.0.1:7878").replace(/\/+$/, ""),
  runtimeToken: requiredCwEnv("RUNTIME_TOKEN"),
  workspace: cwEnv("WORKSPACE") || process.cwd(),
  model: cwEnv("MODEL") || "auto",
  mode: cwEnv("MODE") || "agent",
  allowShell: parseBool(cwEnv("ALLOW_SHELL"), true),
  trustMode: parseBool(cwEnv("TRUST_MODE"), false),
  autoApprove: parseBool(cwEnv("AUTO_APPROVE"), false),
  allowlist: parseList(cwEnv("CHAT_ALLOWLIST")),
  allowUnlisted: parseBool(cwEnv("ALLOW_UNLISTED"), false),
  threadMapPath:
    process.env.TELEGRAM_THREAD_MAP_PATH ||
    "/var/lib/codewhale-telegram-bridge/thread-map.json",
  allowGroups: parseBool(process.env.TELEGRAM_ALLOW_GROUPS, false),
  requirePrefixInGroup: parseBool(process.env.TELEGRAM_REQUIRE_PREFIX_IN_GROUP, true),
  groupPrefix: process.env.TELEGRAM_GROUP_PREFIX || "/ds",
  maxReplyChars: Number(process.env.TELEGRAM_MAX_REPLY_CHARS || 3900),
  pollTimeoutSec: Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC || 50),
  turnTimeoutMs: Number(cwEnv("TURN_TIMEOUT_MS") || 900000)
};

const threadStore = await ThreadStore.open(config.threadMapPath);

let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

const me = await telegramApi("getMe");
console.log("Starting CodeWhale Telegram bridge");
console.log(`Bot: @${me.username || me.id}`);
console.log(`Runtime: ${config.runtimeUrl}`);
console.log(`Workspace: ${config.workspace}`);
if (!config.allowlist.length && !config.allowUnlisted) {
  console.log("No allowlist configured. Incoming chats will receive their IDs and be refused.");
}

// Reattach to any turn that was mid-flight when the bridge restarted, then
// start the long-poll loop. Reattach is awaited so its replies land before the
// loop starts spawning new turns.
await reattachActiveTurns().catch((error) => {
  console.error("failed to reattach active Telegram bridge turns", error);
});

await pollLoop();

// Telegram long polling: one blocking getUpdates call at a time. Updates are
// dispatched fire-and-forget so a long-running turn never blocks the loop —
// that is what lets /interrupt arrive while a turn is streaming.
async function pollLoop() {
  let offset = threadStore.getOffset();
  while (running) {
    let updates;
    try {
      updates = await telegramApi(
        "getUpdates",
        { offset, timeout: config.pollTimeoutSec, allowed_updates: ["message"] },
        { timeoutMs: (config.pollTimeoutSec + 15) * 1000 }
      );
    } catch (error) {
      if (!running) break;
      // 409 Conflict means a second instance is polling the same bot token
      // (commonly an old process that did not exit). Back off harder and warn
      // clearly instead of busy-looping against the conflict.
      if (error.status === 409 || /conflict/i.test(error.description || error.message || "")) {
        console.error(
          "getUpdates conflict: another bridge instance is polling this bot token. Backing off 10s."
        );
        await sleep(10000);
        continue;
      }
      console.error("getUpdates failed; backing off 3s", error.message || error);
      await sleep(3000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      // Persist the offset before handling so a crash mid-turn does not
      // redeliver the message (the runtime keeps the turn; reattach resumes
      // streaming on the next start).
      await threadStore.setOffset(offset);
      if (update.message) {
        void handleIncomingMessage(update.message).catch((error) => {
          console.error("failed to handle incoming Telegram message", error);
        });
      }
    }
  }
  console.log("Telegram bridge stopped.");
}

async function handleIncomingMessage(message) {
  const identity = incomingIdentity(message);
  if (!identity.chatId) return;

  // Cache the forum topic id so replies stay inside the same topic in
  // supergroups (no-op for DMs, where topicId is null).
  const existing = await threadStore.getChat(identity.chatId);
  if (existing) {
    await threadStore.patchChat(identity.chatId, {
      topicId: identity.topicId,
      updatedAt: new Date().toISOString()
    });
  } else {
    await threadStore.setChat(identity.chatId, {
      topicId: identity.topicId,
      threadId: null,
      lastSeq: 0,
      activeTurnId: null,
      updatedAt: new Date().toISOString()
    });
  }

  if (identity.messageType !== "text") {
    await sendText(identity.chatId, "Only text messages are supported in this bridge.");
    return;
  }

  const scoped = stripGroupPrefix(identity.text, {
    chatType: identity.chatType,
    requirePrefix: config.requirePrefixInGroup,
    prefix: config.groupPrefix
  });
  if (!scoped.accepted) return;

  if (identity.messageId && (await threadStore.recordMessage(identity.messageId))) {
    return;
  }

  if (identity.chatType !== "private" && !config.allowGroups) {
    await sendText(
      identity.chatId,
      "Group chat control is disabled for this bridge. DM the bot, or set TELEGRAM_ALLOW_GROUPS=true and allowlist this chat."
    );
    return;
  }

  if (!isAllowed(identity, config.allowlist, config.allowUnlisted)) {
    await sendText(identity.chatId, pairingRefusalText(identity));
    return;
  }

  const command = parseCommand(scoped.text);
  await handleCommand(identity.chatId, command);
}

async function handleCommand(chatId, command) {
  const action = commandAction(command);
  switch (action.kind) {
    case "help":
      await sendText(chatId, helpText());
      return;
    case "status":
      await sendStatus(chatId);
      return;
    case "threads":
      await sendThreads(chatId);
      return;
    case "new_thread": {
      const state = await ensureThread(chatId, { forceNew: true });
      await sendText(chatId, `Created thread ${state.threadId}`);
      return;
    }
    case "resume":
      await resumeThread(chatId, action.threadId);
      return;
    case "interrupt":
      await interruptActiveTurn(chatId);
      return;
    case "compact":
      await compactThread(chatId);
      return;
    case "approval":
      await decideApproval(chatId, action);
      return;
    case "prompt":
      await runPrompt(chatId, action.prompt);
      return;
    default:
      await sendText(chatId, helpText());
  }
}

async function ensureThread(chatId, { forceNew = false } = {}) {
  const existing = await threadStore.getChat(chatId);
  if (existing?.threadId && !forceNew) return existing;

  const thread = await runtimeJson("/v1/threads", {
    method: "POST",
    body: {
      model: config.model,
      workspace: config.workspace,
      mode: config.mode,
      allow_shell: config.allowShell,
      trust_mode: config.trustMode,
      auto_approve: config.autoApprove,
      archived: false,
      system_prompt:
        "You are being controlled from a Telegram phone chat. Keep status updates concise. Ask for tool approvals when needed; do not assume mobile messages imply blanket approval."
    }
  });

  const state = {
    threadId: thread.id,
    lastSeq: 0,
    activeTurnId: null,
    topicId: existing?.topicId ?? null,
    updatedAt: new Date().toISOString()
  };
  await threadStore.setChat(chatId, state);
  return state;
}

async function runPrompt(chatId, prompt) {
  if (!prompt.trim()) {
    await sendText(chatId, helpText());
    return;
  }
  const state = await ensureThread(chatId);
  const detail = await runtimeJson(`/v1/threads/${encodeURIComponent(state.threadId)}`);
  const activeBlock = activeTurnBlock(detail, state);
  if (activeBlock) {
    await threadStore.patchChat(chatId, {
      activeTurnId: activeBlock.turnId,
      updatedAt: new Date().toISOString()
    });
    await sendText(chatId, activeBlock.message);
    return;
  }
  if (state.activeTurnId) {
    await threadStore.patchChat(chatId, { activeTurnId: null });
  }
  const sinceSeq = Number(detail.latest_seq || state.lastSeq || 0);

  const turnResponse = await runtimeJson(
    `/v1/threads/${encodeURIComponent(state.threadId)}/turns`,
    {
      method: "POST",
      body: {
        prompt,
        input_summary: prompt.slice(0, 200),
        model: config.model,
        mode: config.mode,
        allow_shell: config.allowShell,
        trust_mode: config.trustMode,
        auto_approve: config.autoApprove
      }
    }
  );

  const turnId = turnResponse.turn?.id;
  await threadStore.patchChat(chatId, {
    activeTurnId: turnId || null,
    lastSeq: sinceSeq,
    updatedAt: new Date().toISOString()
  });
  await sendText(chatId, `Started turn ${turnId || "(unknown)"}`);

  try {
    await streamTurnEvents(chatId, state.threadId, turnId, sinceSeq);
  } finally {
    await threadStore.patchChat(chatId, {
      activeTurnId: null,
      updatedAt: new Date().toISOString()
    });
  }
}

async function reattachActiveTurns() {
  for (const [chatId, state] of threadStore.listChats()) {
    if (!state?.threadId || !state.activeTurnId) continue;

    const detail = await runtimeJson(`/v1/threads/${encodeURIComponent(state.threadId)}`);
    const runningTurn = latestRunningTurn(detail);
    if (!runningTurn) {
      await threadStore.patchChat(chatId, {
        activeTurnId: null,
        lastSeq: Number(detail.latest_seq || state.lastSeq || 0),
        updatedAt: new Date().toISOString()
      });
      await sendText(chatId, `Bridge restarted. No active turn remains for ${state.threadId}.`);
      continue;
    }

    const turnId = runningTurn.id || state.activeTurnId;
    const sinceSeq = Number(state.lastSeq || 0);
    await threadStore.patchChat(chatId, {
      activeTurnId: turnId,
      updatedAt: new Date().toISOString()
    });
    await sendText(
      chatId,
      `Bridge restarted. Reattaching to active turn ${turnId} from seq ${sinceSeq}.`
    );
    try {
      await streamTurnEvents(chatId, state.threadId, turnId, sinceSeq);
    } finally {
      await threadStore.patchChat(chatId, {
        activeTurnId: null,
        updatedAt: new Date().toISOString()
      });
    }
  }
}

async function streamTurnEvents(chatId, threadId, turnId, sinceSeq) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.turnTimeoutMs);
  let responseText = "";
  let latestSeq = sinceSeq;
  let sentProgressAt = Date.now();

  try {
    const response = await fetch(
      `${config.runtimeUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${sinceSeq}`,
      {
        headers: authHeaders(),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      const body = await readJsonSafe(response);
      throw new Error(compactRuntimeError(response.status, body));
    }

    for await (const event of readSse(response)) {
      if (!event.data) continue;
      const record = JSON.parse(event.data);
      latestSeq = Math.max(latestSeq, Number(record.seq || 0));
      await threadStore.patchChat(chatId, { lastSeq: latestSeq });

      if (turnId && record.turn_id && record.turn_id !== turnId) continue;

      if (record.event === "item.delta" && record.payload?.kind === "agent_message") {
        responseText += record.payload.delta || "";
        const now = Date.now();
        if (responseText.length > config.maxReplyChars && now - sentProgressAt > 15000) {
          await sendText(chatId, responseText.slice(0, config.maxReplyChars));
          responseText = responseText.slice(config.maxReplyChars);
          sentProgressAt = now;
        }
      }

      if (record.event === "approval.required") {
        const approval = record.payload || {};
        await sendText(
          chatId,
          [
            "Approval required",
            `tool=${approval.tool_name || "unknown"}`,
            `approval_id=${approval.approval_id || approval.id}`,
            approval.description || "",
            "",
            `Reply /allow ${approval.approval_id || approval.id}`,
            `Reply /deny ${approval.approval_id || approval.id}`
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      if (record.event === "turn.completed") {
        const turn = record.payload?.turn || {};
        const status = turn.status || "completed";
        const error = turn.error ? `\n${turn.error}` : "";
        if (status !== "completed") {
          await sendText(chatId, `Turn ${status}.${error}`.trim());
        } else {
          await sendText(chatId, responseText.trim() || "Turn completed.");
        }
        return;
      }

      if (record.event === "turn.lifecycle") {
        const status = record.payload?.turn?.status || record.payload?.status;
        if (["failed", "canceled", "interrupted"].includes(status)) {
          await sendText(chatId, `Turn ${status}.`);
          return;
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      await sendText(chatId, `Turn timed out after ${Math.round(config.turnTimeoutMs / 1000)}s.`);
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendStatus(chatId) {
  const [health, runtimeInfo, workspace] = await Promise.all([
    runtimeJson("/health", { auth: false }),
    runtimeJson("/v1/runtime/info"),
    runtimeJson("/v1/workspace/status")
  ]);
  await sendText(
    chatId,
    [
      `runtime=${health.status || "unknown"}`,
      `version=${runtimeInfo.version || "unknown"}`,
      `bind=${runtimeInfo.bind_host}:${runtimeInfo.port}`,
      `auth_required=${runtimeInfo.auth_required}`,
      `workspace=${workspace.workspace}`,
      `git_repo=${workspace.git_repo}`,
      workspace.branch ? `branch=${workspace.branch}` : "",
      `staged=${workspace.staged} unstaged=${workspace.unstaged} untracked=${workspace.untracked}`
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function sendThreads(chatId) {
  const threads = await runtimeJson("/v1/threads/summary?limit=8&include_archived=true");
  if (!threads.length) {
    await sendText(chatId, "No runtime threads yet.");
    return;
  }
  await sendText(
    chatId,
    threads
      .map((thread) => {
        const status = thread.latest_turn_status || "none";
        return `${thread.id} [${status}] ${thread.title || thread.preview || ""}`;
      })
      .join("\n")
  );
}

async function resumeThread(chatId, args) {
  const threadId = String(args || "").trim();
  if (!threadId) {
    await sendText(chatId, "Usage: /resume <thread_id>");
    return;
  }
  const detail = await runtimeJson(`/v1/threads/${encodeURIComponent(threadId)}`);
  const existing = await threadStore.getChat(chatId);
  await threadStore.setChat(chatId, {
    threadId,
    lastSeq: Number(detail.latest_seq || 0),
    activeTurnId: null,
    topicId: existing?.topicId ?? null,
    updatedAt: new Date().toISOString()
  });
  await sendText(chatId, `Resumed thread ${threadId}`);
}

async function interruptActiveTurn(chatId) {
  const state = await threadStore.getChat(chatId);
  if (!state?.threadId) {
    await sendText(chatId, "No runtime thread recorded for this chat.");
    return;
  }
  const detail = await runtimeJson(`/v1/threads/${encodeURIComponent(state.threadId)}`);
  const runningTurn = latestRunningTurn(detail);
  const turnId = state.activeTurnId || runningTurn?.id;
  if (!turnId) {
    await sendText(chatId, "No active turn recorded for this chat.");
    return;
  }
  await runtimeJson(
    `/v1/threads/${encodeURIComponent(state.threadId)}/turns/${encodeURIComponent(
      turnId
    )}/interrupt`,
    { method: "POST" }
  );
  await threadStore.patchChat(chatId, {
    activeTurnId: turnId,
    updatedAt: new Date().toISOString()
  });
  await sendText(chatId, `Interrupt requested for ${turnId}`);
}

async function compactThread(chatId) {
  const state = await ensureThread(chatId);
  const result = await runtimeJson(`/v1/threads/${encodeURIComponent(state.threadId)}/compact`, {
    method: "POST",
    body: { reason: "phone bridge request" }
  });
  await sendText(chatId, `Compaction started: ${result.turn?.id || "unknown turn"}`);
}

async function decideApproval(chatId, action) {
  const decision = action.decision;
  const { approvalId, remember } =
    action.approvalId != null ? action : parseApprovalDecisionArgs(action.args);
  if (!approvalId) {
    await sendText(chatId, `Usage: /${decision} <approval_id>${decision === "allow" ? " [remember]" : ""}`);
    return;
  }
  await runtimeJson(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: { decision, remember }
  });
  await sendText(chatId, `Approval ${approvalId}: ${decision}${remember ? " and remember" : ""}`);
}

async function sendText(chatId, text) {
  const state = await threadStore.getChat(chatId);
  const topicId = state?.topicId ?? null;
  // Telegram rejects message_thread_id for the General/anchor topic (id 1) on
  // send and must have it omitted there; real forum topics keep their id.
  const sendTopicId = topicId != null && topicId !== 1 ? topicId : null;
  for (const chunk of splitMessage(text, config.maxReplyChars)) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      // Echo the forum topic so replies stay in-thread; ignored in DMs.
      ...(sendTopicId != null ? { message_thread_id: sendTopicId } : {}),
      // Plain text only — agent output frequently contains characters that
      // would break Telegram's Markdown/HTML parsers.
      disable_web_page_preview: true
    });
  }
}

async function telegramApi(method, params = {}, options = {}) {
  // Retry loop exists only to honor Telegram's 429 retry_after. All other
  // outcomes (success or hard failure) return/throw on the first pass.
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    let response;
    try {
      response = await fetch(`${config.apiBase}/bot${config.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const body = await readJsonSafe(response);
    if (response.ok && body?.ok) return body.result;

    // 429 Too Many Requests: Telegram tells us exactly how long to wait in
    // parameters.retry_after. Respect it rather than hammering the API.
    const retryAfter = Number(body?.parameters?.retry_after || 0);
    if (response.status === 429 && retryAfter > 0 && attempt < 5) {
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    const description = body?.description || `HTTP ${response.status}`;
    const error = new Error(`Telegram API ${method} failed: ${description}`);
    // Surface status/description so the poll loop can recognize a 409 Conflict
    // (another getUpdates poller is running against this bot token).
    error.status = response.status;
    error.description = description;
    throw error;
  }
}

async function runtimeJson(route, options = {}) {
  const response = await fetch(`${config.runtimeUrl}${route}`, {
    method: options.method || "GET",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await readJsonSafe(response);
  if (!response.ok) {
    throw new Error(compactRuntimeError(response.status, body));
  }
  return body;
}

function authHeaders() {
  return { authorization: `Bearer ${config.runtimeToken}` };
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function* readSse(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, boundary).replace(/\r/g, "");
      buffer = buffer.slice(boundary + 2);
      const event = { event: "", data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        if (line.startsWith("data:")) event.data += line.slice(5).trim();
      }
      yield event;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
