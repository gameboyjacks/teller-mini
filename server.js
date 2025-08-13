// server.js (Node 18–20, ESM)

import fs from "fs";
import path from "path";
import https from "https";
import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// ----- paths / env -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

// mTLS certs from env (Render) or local fallback for dev
function tryRead(p) { try { return fs.readFileSync(path.join(__dirname, p), "utf8"); } catch { return undefined; } }
const cert = process.env.TELLER_CLIENT_CERT || tryRead("./public/dev-certs/client.pem");
const key  = process.env.TELLER_CLIENT_KEY  || tryRead("./public/dev-certs/client.key");
const ca   = process.env.TELLER_CA_CERT     || tryRead("./public/dev-certs/ca.pem");

const tellerAgent = new https.Agent({ cert, key, ca });
const TELLER_API = "https://api.teller.io";

// ----- Postgres (Supabase) -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Ensure minimal schema (safe if already created)
async function ensureSchema() {
  await pool.query(`
    create table if not exists tokens (
      label text primary key,
      access_token text not null,
      updated_at timestamptz default now()
    );
    create table if not exists accounts (
      account_id text primary key,
      bank_label text not null references tokens(label),
      name text,
      type text,
      created_at timestamptz default now()
    );
    create table if not exists account_sync_state (
      account_id text primary key references accounts(account_id) on delete cascade,
      last_seen date not null
    );
  `);
}
ensureSchema().catch(e => console.error("ensureSchema error:", e));

// token helpers
async function setToken(label, token) {
  await pool.query(
    `insert into tokens(label, access_token)
     values ($1,$2)
     on conflict (label) do update set access_token=excluded.access_token, updated_at=now()`,
    [label, token]
  );
}
async function getToken(label) {
  const r = await pool.query(`select access_token from tokens where label=$1`, [label]);
  return r.rows[0]?.access_token;
}
async function listLabels() {
  const r = await pool.query(`select label from tokens order by label`);
  return r.rows.map(x => x.label);
}
async function getTokenForAccount(accountId) {
  const r = await pool.query(
    `select t.access_token
     from accounts a join tokens t on a.bank_label = t.label
     where a.account_id = $1`,
    [accountId]
  );
  return r.rows[0]?.access_token;
}

// upsert accounts by label
async function upsertAccounts(label, accounts) {
  if (!Array.isArray(accounts)) return;
  const text = `
    insert into accounts(account_id, bank_label, name, type)
    values ($1,$2,$3,$4)
    on conflict (account_id) do update
      set bank_label=excluded.bank_label, name=excluded.name, type=excluded.type
  `;
  for (const a of accounts) {
    await pool.query(text, [a.id, label, a.name || null, a.type || null]);
  }
}

// ----- App -----
const app = express();
app.use(express.json());

// Optional: redirect root to connect page
app.get("/", (_req, res) => res.redirect("/connect.html"));

// Serve static only when you want to add banks (toggle with ENABLE_CONNECT=true)
if (process.env.ENABLE_CONNECT === "true") {
  app.use(express.static(path.join(__dirname, "public")));
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Save access token from Teller Connect
app.post("/save-token", async (req, res) => {
  const { access_token, label } = req.body || {};
  if (!access_token) return res.status(400).json({ error: "missing access_token" });
  const k = (label || "default").toLowerCase();
  await setToken(k, access_token);
  console.log("Saved token for label:", k);
  res.json({ ok: true, label: k });
});

// List accounts (also upserts them into DB with bank_label)
app.get("/accounts", async (req, res) => {
  try {
    const label = (req.query.label || "default").toLowerCase();
    const token = await getToken(label);
    if (!token) return res.status(404).json({ error: `no token for label "${label}"` });

    const r = await fetch(`${TELLER_API}/accounts`, {
      agent: tellerAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();

    if (Array.isArray(data)) {
      await upsertAccounts(label, data);
    }
    res.status(r.status).json(data);
  } catch (e) {
    console.error("GET /accounts error:", e);
    res.status(500).json({ error: "accounts_failed" });
  }
});

// Transactions: you can pass ?label=... OR omit it and we'll look up by account_id
app.get("/accounts/:id/transactions", async (req, res) => {
  try {
    const { id } = req.params;
    let token;
    if (req.query.label) token = await getToken(String(req.query.label).toLowerCase());
    else token = await getTokenForAccount(id);

    if (!token) return res.status(404).json({ error: "no token for this account/label" });

    const params = new URLSearchParams();
    if (req.query.from) params.set("from", req.query.from);
    if (req.query.to)   params.set("to", req.query.to);

    const url = `${TELLER_API}/accounts/${encodeURIComponent(id)}/transactions` +
                (params.toString() ? `?${params.toString()}` : "");

    const r = await fetch(url, {
      agent: tellerAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error("GET /accounts/:id/transactions error:", e);
    res.status(500).json({ error: "transactions_failed" });
  }
});

// Optional: forward Teller webhooks to n8n
app.post("/teller-webhook", async (req, res) => {
  try {
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("forward to n8n failed:", e);
    res.json({ ok: true, forwarded: false });
  }
});

// Debug: see which labels we have tokens for
app.get("/debug/labels", async (_req, res) => {
  res.json({ labels: await listLabels() });
});

app.listen(PORT, () => {
  console.log(`teller-mini listening on :${PORT}`);
  if (!cert || !key) console.warn("⚠️ set TELLER_CLIENT_CERT / TELLER_CLIENT_KEY in Render.");
  if (!process.env.DATABASE_URL) console.warn("⚠️ DATABASE_URL not set.");
  if (!process.env.ENABLE_CONNECT) console.log("ℹ️ connect.html disabled unless ENABLE_CONNECT=true");
});
