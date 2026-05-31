# Telegram Bridge

This bridge lets a Telegram chat control a local `codewhale serve --http`
runtime from your phone. It uses the Telegram Bot API in **long-polling** mode
(`getUpdates`), so it needs no public webhook URL, no inbound ports, and no TLS
certificate — the bridge only makes outbound calls to `api.telegram.org`.

It is a sibling of [`../feishu-bridge`](../feishu-bridge) and shares the same
runtime control surface, command set, and security model. It has **zero runtime
dependencies** (Node 18+ `fetch` only), so `npm install` is a no-op.

Security model:

- `codewhale serve --http` stays bound to `127.0.0.1`.
- `/v1/*` runtime calls use `CODEWHALE_RUNTIME_TOKEN` (legacy
  `DEEPSEEK_RUNTIME_TOKEN` is accepted during the rename window).
- **Anyone can message a Telegram bot**, so chats must be allowlisted by numeric
  `chat_id`/`user_id` unless `CODEWHALE_ALLOW_UNLISTED=true` is set for first
  pairing. Run `/setprivacy` in BotFather to keep the bot from seeing all group
  chatter.
- Direct messages are the intended control surface. Group control is disabled
  unless `TELEGRAM_ALLOW_GROUPS=true`, and then requires the `/ds` prefix.
- Tool approvals are text commands: `/allow <approval_id>` or `/deny <approval_id>`.

## Create the bot

1. In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot`, pick a
   name and username → copy the token into `TELEGRAM_BOT_TOKEN`.
2. `/setprivacy` → **Enable** (bot only sees commands/replies, not all messages).
3. First pairing: set `CODEWHALE_ALLOW_UNLISTED=true`, start the bridge, DM the
   bot anything. It refuses you but prints your `chat_id`. Paste that into
   `CODEWHALE_CHAT_ALLOWLIST`, set `CODEWHALE_ALLOW_UNLISTED=false`, restart.

## Railway Worker

For the always-on Railway path, use the root `railway.json` and
[`../../deploy/railway`](../../deploy/railway). That worker image runs
`codewhale serve --http` on loopback and this bridge in the same private
container, so no public runtime API is exposed.

## Setup

```bash
cd /opt/codewhale/telegram-bridge
npm install --omit=dev   # no-op: zero runtime deps
sudo mkdir -p /etc/codewhale
cp .env.example /etc/codewhale/telegram-bridge.env
sudoedit /etc/codewhale/telegram-bridge.env
node src/index.mjs
```

Validate the env files before starting the service:

```bash
npm run validate:config -- \
  --env /etc/codewhale/telegram-bridge.env \
  --runtime-env /etc/codewhale/runtime.env \
  --workspace-root /opt/whalebro \
  --check-filesystem
```

Run as a service (cloud-agnostic; the unit lives in `deploy/`):

```bash
sudo cp deploy/codewhale-telegram-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codewhale-runtime codewhale-telegram-bridge
sudo journalctl -u codewhale-telegram-bridge -f
```

## Commands

- `/status`
- `/threads`
- `/new`
- `/resume <thread_id>`
- `/interrupt`
- `/compact`
- `/allow <approval_id> [remember]`
- `/deny <approval_id>`

Anything else is sent as a prompt. `/start` and `/help` both show help.
If group control is enabled, messages must start with `/ds` by default:

```text
/ds check git status and tell me what is dirty
```
