import fs from "fs";
import https from "https";
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(express.static("public")); // serves /connect.html

// mTLS agent for Teller
const agent = new https.Agent({
  cert: fs.readFileSync(process.env.TELLER_CLIENT_CERT_PATH), // ./certs/client.pem
  key:  fs.readFileSync(process.env.TELLER_CLIENT_KEY_PATH),  // ./certs/client.key
  ca:   process.env.TELLER_CA_PATH ? fs.readFileSync(process.env.TELLER_CA_PATH) : undefined,
});

// super-basic token store (swap for a DB later)
const TOKENS = new Map();

// Save access token from Connect
app.post("/save-token", (req, res) => {
  const { access_token, label } = req.body || {};
  if (!access_token) return res.status(400).json({ error: "missing access_token" });
  TOKENS.set(label || "default", access_token);
  res.json({ ok: true });
});

// List accounts for a saved token
app.get("/accounts", async (req, res) => {
  const token = TOKENS.get(req.query.label || "default");
  if (!token) return res.status(404).json({ error: "no token" });
  const r = await fetch("https://api.teller.io/accounts", {
    agent, headers: { Authorization: `Bearer ${token}` },
  });
  res.status(r.status).json(await r.json());
});

// Fetch transactions for an account
app.get("/accounts/:id/transactions", async (req, res) => {
  const token = TOKENS.get(req.query.label || "default");
  if (!token) return res.status(404).json({ error: "no token" });
  const r = await fetch(`https://api.teller.io/accounts/${req.params.id}/transactions`, {
    agent, headers: { Authorization: `Bearer ${token}` },
  });
  res.status(r.status).json(await r.json());
});

// Webhook from Teller → forward to n8n
app.post("/teller-webhook", async (req, res) => {
  // TODO: verify signatures if enabled (good hardening step)
  try {
    await fetch(process.env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
  } catch (e) { /* log if you want */ }
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("teller-mini listening on :" + port));
