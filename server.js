// server.js
// Teller → Supabase sync backend (ESM). Deploy as a Render Web Service.
// Requires env vars: TELLER_ENV, TELLER_CERT_PEM_B64, TELLER_KEY_PEM_B64,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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
  TELLER_ENV = "development",                 // development | production | (sandbox not used here)
  TELLER_CERT_PEM_B64,                        // base64 of client cert PEM (required for dev/prod)
  TELLER_KEY_PEM_B64,                         // base64 of client key PEM (required for dev/prod)
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}
if (TELLER_ENV !== "sandbox" && (!TELLER_CERT_PEM_B64 || !TELLER_KEY_PEM_B64)) {
  throw new Error("Missing Teller mTLS env vars (TELLER_CERT_PEM_B64 / TELLER_KEY_PEM_B64).");
}

// ---------- Supabase ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- mTLS Agent ----------
let httpsAgent = undefined;
if (TELLER_ENV !== "sandbox") {
  const CERT_PATH = "/tmp/teller_client.pem";
  const KEY_PATH = "/tmp/teller_client.key";
  fs.writeFileSync(CERT_PATH, Buffer.from(TELLER_CERT_PEM_B64, "base64"));
  fs.writeFileSync(KEY_PATH, Buffer.from(TELLER_KEY_PEM_B64, "base64"));
  httpsAgent = new https.Agent({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
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
    timeout: 30_000,
  });
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(`Teller ${res.status}: ${body}`);
  }
  return res.data;
}

async function listAccounts(accessToken) {
  return tellerGET("/accounts", accessToken);
}

async function fetchTransactions(accountId, accessToken, { count = 500, fromId = null } = {}) {
  const qs = new URLSearchParams();
  if (count) qs.set("count", String(count));
  if (fromId) qs.set("from_id", fromId);
  return tellerGET(`/accounts/${accountId}/transactions?${qs.toString()}`, accessToken);
}

// ---------- Express ----------
const app = express();
app.use(express.json());

// (Optional) simple CORS if you ever hit this from another origin
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve a minimal page if you keep /public (optional)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/", (_, res) => res.sendFile(path.join(publicDir, "index.html")));
}

app.get("/healthz", (_, res) => res.status(200).json({ ok: true, env: TELLER_ENV }));

// ---------- Token storage (one-time after Connect) ----------
app.post("/save-token", async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: "Missing accessToken" });

    // table: teller_tokens(access_token text, user_id uuid default gen_random_uuid())
    const { error } = await supabase
      .from("teller_tokens")
      .upsert({ access_token: accessToken }, { onConflict: "user_id" });

    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Full backfill sync ----------
app.post("/sync", async (req, res) => {
  try {
    const { accessToken, count = 500 } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: "Missing accessToken" });

    const accounts = await listAccounts(accessToken);
    let txnTotal = 0;

    for (const a of accounts) {
      const instId = a?.institution?.id ?? null;
      const instName = a?.institution?.name ?? null;

      if (instId && instName) {
        await supabase.rpc("upsert_institution", { p_id: instId, p_name: instName });
      }

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

      const txns = await fetchTransactions(a.id, accessToken, { count });
      txnTotal += txns.length;

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

      // initialize delta cursor to newest txn we just saw
      if (txns.length) {
        const newest = txns[0].id; // Teller returns newest first
        await supabase
          .from("teller_sync_state")
          .upsert({ account_id: a.id, last_seen_txn_id: newest, updated_at: new Date().toISOString() },
                  { onConflict: "account_id" });
      }
    }

    res.json({ ok: true, accounts: accounts.length, transactions: txnTotal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Incremental sync (for “every swipe” polling) ----------
app.post("/sync-delta", async (req, res) => {
  try {
    // Access token: prefer body, else most recent saved
    let accessToken = req.body?.accessToken || null;
    if (!accessToken) {
      const { data: t, error } = await supabase
        .from("teller_tokens")
        .select("access_token")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      accessToken = t?.access_token;
    }
    if (!accessToken) return res.status(400).json({ error: "No access token on file" });

    const accounts = await listAccounts(accessToken);

    let inserted = 0;
    for (const a of accounts) {
      // read cursor
      const { data: state, error: stateErr } = await supabase
        .from("teller_sync_state")
        .select("last_seen_txn_id")
        .eq("account_id", a.id)
        .maybeSingle();
      if (stateErr) throw stateErr;

      const fromId = state?.last_seen_txn_id || null;
      const txns = await fetchTransactions(a.id, accessToken, { fromId, count: 500 });

      // insert oldest→newest so running balances look sane in order
      const ordered = [...txns].reverse();
      for (const t of ordered) {
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
        inserted++;
      }

      if (txns.length) {
        const newest = txns[0].id; // newest-first from Teller
        await supabase
          .from("teller_sync_state")
          .upsert(
            { account_id: a.id, last_seen_txn_id: newest, updated_at: new Date().toISOString() },
            { onConflict: "account_id" }
          );
      }
    }
app.post('/webhook', express.json(), async (req, res) => {
  const event = req.body;

  if (event.type === 'transactions.processed') {
    const transactions = event.data.transactions;

    for (const txn of transactions) {
      await supabase
        .from('transactions')
        .upsert({
          id: txn.id,
          description: txn.description,
          amount: txn.amount,
          date: txn.date
        });
    }
  }
  res.sendStatus(200);
});
    res.json({ ok: true, new_transactions: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Start ----------
const listenPort = Number(PORT) || 8001;
app.listen(listenPort, () => {
  console.log(`teller-supabase-sync listening on :${listenPort} (env=${TELLER_ENV})`);
});
