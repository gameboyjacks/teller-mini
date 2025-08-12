// server.js (Node 18–20, ESM)

import fs from "fs";
import path from "path";
import https from "https";
import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

// Resolve __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Config -----
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ""; // your n8n Webhook (POST) URL

// mTLS certs: prefer ENV (Render), fallback to local files for dev
function tryRead(p) {
  try { return fs.readFileSync(path.join(__dirname, p), "utf8"); }
  catch { return undefined; }
}
const cert = process.env.TELLER_CLIENT_CERT || tryRead("./public/dev-certs/client.pem");
const key  = process.env.TELLER_CLIENT_KEY  || tryRead("./public/dev-certs/client.key");
const ca   = process.env.TELLER_CA_CERT     || tryRead("./public/dev-certs/ca.pem");

const tellerAgent = new https.Agent({ cert, key, ca });

const TELLER_API = "https://api.teller.io";

// super-simple token store (Map<label, access_token>); use a DB later if you want persistence
const TOKENS = new Map();

const app = express();
app.use(express.json());

// Serve static (connect.html)
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Save access token from Teller Connect
// POST /save-token  { access_token, label? }
app.post("/save-token", (req, res) => {
  const { access_token, label } = req.body || {};
  if (!access_token) return res.status(400).json({ error: "missing access_token" });
  const k = (label || "default").toLowerCase();
  TOKENS.set(k, access_token);
  return res.json({ ok: true, label: k });
});

// List accounts for a label (default if omitted)
app.get("/accounts", async (req, res) => {
  try {
    const label = (req.query.label || "default").toLowerCase();
    const token = TOKENS.get(label);
    if (!token) return res.status(404).json({ error: `no token for label "${label}"` });

    const r = await fetch(`${TELLER_API}/accounts`, {
      agent: tellerAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("GET /accounts error:", e);
    return res.status(500).json({ error: "accounts_failed" });
  }
});

// Transactions for an account (optionally since a date)
// GET /accounts/:id/transactions?label=<bank>&from=YYYY-MM-DD
app.get("/accounts/:id/transactions", async (req, res) => {
  try {
    const label = (req.query.label || "default").toLowerCase();
    const token = TOKENS.get(label);
    if (!token) return res.status(404).json({ error: `no token for label "${label}"` });

    const { id } = req.params;
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
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("GET /accounts/:id/transactions error:", e);
    return res.status(500).json({ error: "transactions_failed" });
  }
});

// Teller webhook receiver → forward to n8n
app.post("/teller-webhook", async (req, res) => {
  try {
    if (N8N_WEBHOOK_URL) {
      await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /teller-webhook forward error:", e);
    return res.json({ ok: true, forwarded: false });
  }
});

app.listen(PORT, () => {
  console.log(`teller-mini listening on :${PORT}`);
  if (!cert || !key) {
    console.warn("⚠️  Missing mTLS cert or key. Set TELLER_CLIENT_CERT / TELLER_CLIENT_KEY / TELLER_CA_CERT in Render (or put dev certs in public/dev-certs for local).");
  }
  if (!N8N_WEBHOOK_URL) {
    console.warn("ℹ️  N8N_WEBHOOK_URL not set — webhooks will be received but not forwarded to n8n.");
  }
});
