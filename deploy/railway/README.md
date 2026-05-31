# Railway Telegram Agent

This deploys a private CodeWhale worker on Railway. The container runs two
local processes:

- `codewhale serve --http` bound to `127.0.0.1`
- `integrations/telegram-bridge`, which long-polls Telegram and talks to the
  local runtime API

There is no public `/v1/*` endpoint. Telegram is the control surface, and
`CODEWHALE_CHAT_ALLOWLIST` is the access gate.

## Railway Project

Create or link the project from the repo root:

```bash
railway link --project ad854150-193a-48e0-8417-b5cf54321fc7 --environment production
railway add --service codewhale-agent
```

The root `railway.json` uses `deploy/railway/Dockerfile`.

## Required Variables

Set secrets with `--stdin`; do not paste token values into chat logs.

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" \
  | railway variable set TELEGRAM_BOT_TOKEN --stdin --environment production --service codewhale-agent

printf '%s' "$CODEWHALE_RUNTIME_TOKEN" \
  | railway variable set CODEWHALE_RUNTIME_TOKEN --stdin --environment production --service codewhale-agent

printf '%s' "$DEEPSEEK_API_KEY" \
  | railway variable set DEEPSEEK_API_KEY --stdin --environment production --service codewhale-agent
```

Recommended non-secret defaults:

```bash
railway variable set CODEWHALE_REPO_URL=https://github.com/Hmbown/CodeWhale.git --environment production --service codewhale-agent
railway variable set CODEWHALE_GIT_BRANCH=main --environment production --service codewhale-agent
railway variable set CODEWHALE_WORKSPACE=/workspace/codewhale --environment production --service codewhale-agent
railway variable set CODEWHALE_MODE=agent --environment production --service codewhale-agent
railway variable set CODEWHALE_ALLOW_SHELL=true --environment production --service codewhale-agent
railway variable set CODEWHALE_AUTO_APPROVE=false --environment production --service codewhale-agent
railway variable set CODEWHALE_ALLOW_UNLISTED=true --environment production --service codewhale-agent
```

First pairing flow:

1. Set `CODEWHALE_ALLOW_UNLISTED=true`.
2. DM the bot `/start`; it will reply with `chat_id=...`.
3. Set `CODEWHALE_CHAT_ALLOWLIST=<that id>`.
4. Set `CODEWHALE_ALLOW_UNLISTED=false`.
5. Redeploy or restart the service.

For private repo writes, also set `CODEWHALE_GITHUB_TOKEN` with a minimally
scoped token. The start script uses it only for `git clone`, then rewrites
`origin` back to the clean repository URL so the token is not left in git config.

## Deploy

```bash
railway up --service codewhale-agent --environment production --detach
railway logs --service codewhale-agent --environment production
```

Use a Railway volume mounted at `/var/lib/codewhale-telegram-bridge` if you want
the Telegram thread map and update offset to survive redeploys.
