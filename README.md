# Monarch Smart CFO — Copilot-Style Financial Intelligence for Unraid

Self-hosted 3-pane Personal CFO & Smart Finance Dashboard powered by the official **Monarch Money MCP Connector** (`https://api.monarch.com/mcp`) and Node 24's built-in `node:sqlite`.

## Features
- **3-Pane Split-View App Shell:** Left Navigation Rail (with `☀️ / 🌙` Apple Dark & Crisp Daylight themes and `All / Joint / Partner A / Partner B` household filtering), Center Visual Canvas, and Slide-Out Master-Detail Inspector Drawer.
- **Copilot-Style Category Budget Bars:** Color-coded categories with a vertical **"Today"** pace marker, 6-month velocity bar charts, and live `Fixed Baseline` vs. `Discretionary` reclassification.
- **Interactive Cash Flow Sankey & Burn Studio:** Curved Bezier Sankey diagram + live sliders for Checking Safety Buffer, Target HYSA APY, and Discretionary Trim %.
- **Stage & Approve Triage Queue + Local SQLite Undo Log:** Preview before/after diffs for uncategorized transactions, messy Square/Toast descriptors, and duplicate charges before writing back to Monarch MCP—with 1-click Undo backed by local SQLite snapshots.
- **Dedicated CFO Briefings Tab & Alert Webhooks:** Keep walls of text off the visual dashboard with a dedicated narrative memo tab, `POST /api/briefings/agent-push` endpoint for AI assistants, and Discord / Slack / ntfy / Home Assistant webhook support.

---

## Unraid Setup Guide

### Step 1: Make the GHCR Container Image Public (One-Time After First GitHub Action Run)
Every push to `main` runs a **Security & Privacy Audit** (blocking any private keys, tokens, LAN IPs, or `.sqlite` files) and publishes a multi-stage `node:24-alpine` container image to:
```text
ghcr.io/acalvare/monarch-smart-cfo:latest
```
> **Important GHCR Tip for Unraid:** GitHub defaults new container packages to *Private* even when the repository is public. Once the **Build & Publish Unraid Docker Image (GHCR)** workflow finishes on GitHub:
> 1. Open your package page: `https://github.com/users/acalvare/packages/container/package/monarch-smart-cfo`
> 2. Click **Package settings** (bottom right sidebar).
> 3. Scroll to **Danger Zone → Change package visibility** and set it to **Public**.
> *(This allows Unraid to pull `ghcr.io/acalvare/monarch-smart-cfo:latest` directly without needing `docker login ghcr.io` credentials!)*

---

### Step 2: Deploy the Container on Unraid

Choose **Option A** (Unraid Native Docker UI) or **Option B** (Docker Compose Manager / Dockge / Portainer).

#### Option A1: Unraid 1-Command XML Template Install (Fastest)
Open the **Unraid Web Terminal** (`>_` icon in the top-right of the Unraid WebGUI) and run:
```bash
curl -fsSL https://raw.githubusercontent.com/acalvare/monarch-smart-cfo/main/unraid-template.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-monarch-smart-cfo.xml
```
Then in the Unraid WebGUI:
1. Go to **Docker → Add Container** (at the bottom of the page).
2. In the **Template** dropdown at the top, select **`monarch-smart-cfo`** (under `[ User Templates ]`).
3. All ports (`3080`), paths (`/mnt/user/appdata/monarch-cfo` → `/data`), and optional environment variables are pre-filled.
4. Click **Apply** and open `http://<your-unraid-ip>:3080`.

#### Option A2: Unraid Manual "Add Container" UI
1. In the Unraid WebGUI, go to **Docker → Add Container**.
2. Toggle **Basic View → Advanced View** (top-right switch) and enter:
   - **Name:** `monarch-smart-cfo`
   - **Repository:** `ghcr.io/acalvare/monarch-smart-cfo:latest`
   - **WebUI:** `http://[IP]:[PORT:3080]/`
3. Click **+ Add another Path, Port, Variable, Label or Device** for each of the following:
   - **Port:** Container Port `3080` → Host Port `3080` (`TCP`)
   - **Path:** Container Path `/data` → Host Path `/mnt/user/appdata/monarch-cfo` (`Read/Write`)
   - **Variable (Optional):** `TZ` = `America/Los_Angeles` (or your local timezone)
   - **Variable (Optional):** `MONARCH_MCP_URL` = `https://api.monarch.com/mcp`
   - **Variable (Optional):** `MONARCH_OAUTH_TOKEN` = `<your-monarch-mcp-oauth-token>`
   - **Variable (Optional):** `WEEKLY_MCP_QUOTA_BUDGET` = `150`
   - **Variable (Optional):** `WEBHOOK_TYPE` = `none` (`discord`, `slack`, `ntfy`, or `homeassistant`)
   - **Variable (Optional):** `WEBHOOK_URL` = `<your-webhook-url>`
4. Click **Apply**.

#### Option B: Unraid Docker Compose Manager / Dockge / Portainer
Create a new stack using [`docker-compose.yml`](./docker-compose.yml):
```yaml
services:
  monarch-cfo:
    image: ghcr.io/acalvare/monarch-smart-cfo:latest
    container_name: monarch-smart-cfo
    restart: unless-stopped
    ports:
      - "3080:3080"
    volumes:
      - /mnt/user/appdata/monarch-cfo:/data
    environment:
      - PORT=3080
      - DATA_DIR=/data
      - TZ=America/Los_Angeles
      - MONARCH_MCP_URL=https://api.monarch.com/mcp
      - WEEKLY_MCP_QUOTA_BUDGET=150
```

---

### Step 3: Connect Official Monarch Money MCP & Quota Caching
1. **Official Endpoint:** Monarch's hosted MCP server lives at `https://api.monarch.com/mcp` and authenticates via OAuth 2.0 (`read` scope for balances, transactions, and budgets; `write` scope for Stage & Approve triage write-backs).
2. **Zero-Quota Local SQLite Caching:** All synced accounts, categories, recurring bills, and transactions are stored in `/mnt/user/appdata/monarch-cfo/monarch-cfo.sqlite` (WAL mode). Browsing the dashboard, switching between `All / Joint / Partner A / Partner B`, and running cash-flow simulations read 100% from local SQLite and consume **0 weekly Monarch MCP requests**.
3. **Stage & Approve + Local Undo Log:** Nothing is ever written back to Monarch automatically. When you click **Approve & Write via MCP** in the Triage view or Right Inspector Drawer, the before-state is recorded in the SQLite `undo_log` table so you can revert any change with 1 click.

---

### Step 4: Push Briefings from Your AI Agent (`POST /api/briefings/agent-push`)
Any external AI assistant connected to Monarch MCP (Claude Desktop, Cursor, Antigravity, or custom cron scripts) can push rich narrative briefings directly into your Unraid dashboard's **📝 CFO Briefings** tab (and trigger your configured Discord/Slack/ntfy/Home Assistant webhook):

```bash
curl -X POST http://<your-unraid-ip>:3080/api/briefings/agent-push \
  -H "Content-Type: application/json" \
  -d '{
    "cadence": "weekly",
    "source": "Claude / Antigravity + Monarch MCP",
    "headline": "Weekly Pulse: Pace is $240 under target; 2 items ready for review.",
    "narrative_markdown": "Your fixed obligations are 85% cleared for the month, and discretionary dining cooled 18% week-over-week.",
    "action_playbook": [
      {
        "title": "Sweep $23,500 excess checking cash to HYSA",
        "impact": "+$998/yr",
        "action": "Open Idle Cash Inspector"
      }
    ],
    "trigger_webhook": true
  }'
```

---

## Local Development
```bash
node --version   # Requires Node.js >= 22.5 (Node 24 LTS recommended for built-in node:sqlite)
npm start        # Starts server on http://localhost:3080 with SQLite DB in ./data/monarch-cfo.sqlite
```
