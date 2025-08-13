// server.js
// Minimal backend that:
// 1) Serves a tiny Connect page from /public
// 2) Accepts POST /sync { accessToken } from the page
// 3) Calls Teller (mTLS in dev/prod) and writes to Supabase via RPC upserts

import express from "express";
import path from "path";
import fs from "fs";
import https from "https";
import axios from "axios";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- ENV ----------
const {
  PORT,
  TELLER_ENV = "development", // development | production (no sandbox here)
  TELLER_CERT_PEM_B64,        // base64 of your client cert PEM
  TELLER_KEY_PEM_B64,         // base64 of your client key PEM
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
}
if (TELLER_ENV !== "sandbox" && (!TELLER_CERT_PEM_B64 || !TELLER_KEY_PEM_B64)) {
  throw new Error("Missing Teller mTLS env vars (CERT/KEY) for development/production.");
}

// ---------- Supabase (server-side only) ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- Decode certs for mTLS ----------
let httpsAgent = undefined;
if (TELLER_ENV !== "sandbox") {
  const CERT_PATH = "/tmp/teller_client.pem";
  const KEY_PATH  = "/tmp/teller_client.key";
  fs.writeFileSync(CERT_PATH, Buffer.from(TELLER_CERT_PEM_B64, "base64"));
  fs.writeFileSync(KEY_PATH,  Buffer.from(TELLER_KEY_PEM_B64, "base64"));
  httpsAgent = new https.Agent({
    cert: fs.readFileSync(CERT_PATH),
    key:  fs.readFileSync(KEY_PATH),
  });
}

// ---------- Helpers ----------
const TELLER_BASE = "https://api.teller.io";

const authHeader = (accessToken) =>
  `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`;

async function tellerGET(pathname, accessToken) {
  const url = `${TELLER_BASE}${pathname}`;
  const res = await axios.get(url, {
    httpsAgent,
    headers: { Authorization: authHeader(accessToken) },
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Teller ${res.status}: ${typeof res.data === "string" ? res.data : JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ---------- Express ----------
const app = express();
app.use(express.json());

// (Optional) CORS if you later host the HTML elsewhere
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve the Connect page
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true, env: TELLER_ENV }));

// Main sync endpoint
app.post("/sync", async (req, res) => {
  try {
    const { accessToken, count = 500 } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: "Missing accessToken" });

    // 1) List accounts
    const accounts = await tellerGET("/accounts", accessToken);

    let txnTotal = 0;

    for (const a of accounts) {
      const instId = a?.institution?.id ?? null;
      const instName = a?.institution?.name ?? null;

      // Upsert institution
      if (instId && instName) {
        await supabase.rpc("upsert_institution", { p_id: instId, p_name: instName });
      }

      // Upsert account
      await supabase.rpc("upsert_account", {
        p_id: a.id,
        p_institution_id: instId,
        p_name: a.name,
        p_type: a.type,
        p_subtype: a.subtype,
        p_last_four: a.last_four,
        p_currency: a.currency,
        p_status: a.status,
        p_raw: a,
      });

      // 2) Transactions (grab latest 'count')
      const txns = await tellerGET(`/accounts/${a.id}/transactions?count=${count}`, accessToken);
      txnTotal += Array.isArray(txns) ? txns.length : 0;

      // Upsert transactions
      for (const t of txns) {
        await supabase.rpc("upsert_transaction", {
          p_id: t.id,
          p_account_id: t.account_id,
          p_posted_date: t.date,
          p_description: t.description,
          p_amount: Number(t.amount),
          p_type: t.type,
          p_status: t.status,
          p_running_balance: t.running_balance != null ? Number(t.running_balance) : null,
          p_details: t.details ?? null,
          p_raw: t,
        });
      }
    }

    res.json({ ok: true, accounts: accounts.length, transactions: txnTotal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Start
const listenPort = Number(PORT) || 8001;
app.listen(listenPort, () => {
  console.log(`teller-supabase-sync listening on :${listenPort} (env=${TELLER_ENV})`);
});
