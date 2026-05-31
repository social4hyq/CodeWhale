import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commandAction,
  incomingIdentity,
  isAllowed,
  parseCommand,
  splitMessage,
  stripGroupPrefix,
  validateBridgeConfig
} from "../src/lib.mjs";

test("incomingIdentity reads Telegram message shape", () => {
  const identity = incomingIdentity({
    message_id: 42,
    chat: { id: 12345, type: "private" },
    from: { id: 999, username: "ralph" },
    text: "hello"
  });
  assert.equal(identity.chatId, "12345");
  assert.equal(identity.messageId, "42");
  assert.equal(identity.chatType, "private");
  assert.equal(identity.userId, "999");
  assert.equal(identity.username, "ralph");
  assert.equal(identity.messageType, "text");
  assert.equal(identity.text, "hello");
  assert.equal(identity.topicId, null);
});

test("incomingIdentity flags non-text messages and forum topics", () => {
  const identity = incomingIdentity({
    message_id: 7,
    chat: { id: -100200, type: "supergroup" },
    from: { id: 5 },
    message_thread_id: 88,
    photo: [{ file_id: "x" }]
  });
  assert.equal(identity.messageType, "other");
  assert.equal(identity.topicId, 88);
});

test("isAllowed matches chat id or user id", () => {
  const identity = { chatId: "12345", userId: "999" };
  assert.equal(isAllowed(identity, ["12345"], false), true);
  assert.equal(isAllowed(identity, ["999"], false), true);
  assert.equal(isAllowed(identity, ["nope"], false), false);
  assert.equal(isAllowed(identity, [], true), true);
});

test("parseCommand strips @botname suffix used in groups", () => {
  assert.deepEqual(parseCommand("/status@code_whale_bot"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/resume thread-1"), { name: "resume", args: "thread-1" });
  assert.deepEqual(parseCommand("just a prompt"), { name: "prompt", args: "just a prompt" });
});

test("commandAction maps /start to help", () => {
  assert.deepEqual(commandAction({ name: "start", args: "" }), { kind: "help" });
});

test("stripGroupPrefix accepts DMs and prefixed group messages", () => {
  assert.deepEqual(
    stripGroupPrefix("hi", { chatType: "private", requirePrefix: true, prefix: "/ds" }),
    { accepted: true, text: "hi" }
  );
  assert.deepEqual(
    stripGroupPrefix("hi", { chatType: "supergroup", requirePrefix: true, prefix: "/ds" }),
    { accepted: false, text: "" }
  );
  assert.deepEqual(
    stripGroupPrefix("/ds do it", { chatType: "supergroup", requirePrefix: true, prefix: "/ds" }),
    { accepted: true, text: "do it" }
  );
});

test("splitMessage respects Telegram's character ceiling", () => {
  const chunks = splitMessage("x".repeat(9000), 3900);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 3900));
});

test("validateBridgeConfig passes a complete config and flags a remote runtime", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFake",
    DEEPSEEK_RUNTIME_URL: "http://127.0.0.1:7878",
    DEEPSEEK_RUNTIME_TOKEN: "shared-secret-token",
    DEEPSEEK_WORKSPACE: "/opt/whalebro",
    TELEGRAM_THREAD_MAP_PATH: "/var/lib/codewhale-telegram-bridge/thread-map.json",
    DEEPSEEK_CHAT_ALLOWLIST: "12345"
  };
  assert.equal(validateBridgeConfig(base).ok, true);

  const remote = validateBridgeConfig({ ...base, DEEPSEEK_RUNTIME_URL: "http://10.0.0.5:7878" });
  assert.equal(remote.ok, false);
  assert.ok(remote.errors.some((e) => e.code === "remote_runtime_url"));
});

test("validateBridgeConfig rejects a reply cap above Telegram's limit", () => {
  const result = validateBridgeConfig({
    TELEGRAM_BOT_TOKEN: "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFake",
    DEEPSEEK_RUNTIME_URL: "http://127.0.0.1:7878",
    DEEPSEEK_RUNTIME_TOKEN: "shared-secret-token",
    DEEPSEEK_WORKSPACE: "/opt/whalebro",
    TELEGRAM_THREAD_MAP_PATH: "/var/lib/codewhale-telegram-bridge/thread-map.json",
    TELEGRAM_MAX_REPLY_CHARS: "5000"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "max_reply_chars_over_limit"));
});
