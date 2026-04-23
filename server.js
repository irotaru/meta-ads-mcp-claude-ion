/**
 * Meta Ads MCP Server v4.1.0
 * Compatible cu Claude.ai custom connectors — Streamable HTTP transport
 * Meta Marketing API v25.0
 *
 * CHANGELOG v4.1.0 (vs 4.0.0):
 *  - Auth prin query parameter ?key=SECRET (compatibil Claude.ai custom connector UI)
 *  - Suport paralel pentru Authorization: Bearer header (alti clienti MCP)
 *  - Timing-safe comparison pentru secret (previne timing attacks)
 *
 * CHANGELOG v4.0.0 (vs 3.5.0):
 *  - Multi-account support: ad_account_id optional in toate tool-urile
 *    (fallback pe META_AD_ACCOUNT_ID env var pentru backward compat)
 *  - Tool nou: list_ad_accounts — listeaza toate conturile accesibile de token
 *  - Tool nou: get_campaign_full — agregă campaign + adsets + ads + insights
 *  - SECURITY: token in Authorization header, nu in URL (elimina leak risk in logs)
 *  - SECURITY: autentificare obligatorie pe /mcp cu MCP_SECRET
 *  - Retry pe 5xx erori tranzitorii (500, 502, 503, 504), nu doar 429
 *  - Fail-fast la boot daca lipsesc env vars critice
 *  - frequency_cap returneaza warning daca e ignorat, nu silent
 *  - update_ad: removed creative_id (Meta API nu permite schimbarea creative-ului)
 *  - Paginare pe list endpoints via cursor next
 *  - Mesaje eroare mai clare cand ad_account_id lipseste
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { timingSafeEqual } from "crypto";

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN         = process.env.META_ADS_ACCESS_TOKEN;
const DEFAULT_ACCT  = process.env.META_AD_ACCOUNT_ID; // fallback pentru backward compat
const MCP_SECRET    = process.env.MCP_SECRET;
const API           = "https://graph.facebook.com/v25.0";
const PORT          = process.env.PORT || 3000;

// Fail-fast la boot — oprim serverul daca lipsesc variabile critice
function validateEnv() {
  const missing = [];
  if (!TOKEN)      missing.push("META_ADS_ACCESS_TOKEN");
  if (!MCP_SECRET) missing.push("MCP_SECRET");
  if (missing.length) {
    console.error(`\n❌ CONFIGURARE INVALIDA: Variabile lipsa in Railway:\n   - ${missing.join("\n   - ")}`);
    console.error(`\nServer oprit. Seteaza variabilele si redeploy.\n`);
    process.exit(1);
  }
  if (!DEFAULT_ACCT) {
    console.warn(`⚠ META_AD_ACCOUNT_ID nesetat — fiecare tool call va necesita ad_account_id explicit.`);
  }
}
validateEnv();

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Normalizeaza un ID de cont: accepta "1234567890", "act_1234567890" → intoarce "1234567890" */
function normalizeAccountId(id) {
  if (!id) return null;
  return String(id).replace(/^act_/, "");
}

/** Rezolva contul de folosit: param explicit > env var default. Arunca eroare clara daca lipsesc ambele. */
function resolveAccount(explicit) {
  const acct = normalizeAccountId(explicit) || normalizeAccountId(DEFAULT_ACCT);
  if (!acct) {
    throw new Error(
      "Nu este specificat ad_account_id si nici META_AD_ACCOUNT_ID nu e setat in Railway. " +
      "Foloseste list_ad_accounts pentru a vedea conturile disponibile si specifica ad_account_id in parametri."
    );
  }
  return acct;
}

/**
 * Apelul central catre Graph API.
 * - Token in Authorization header (nu in URL)
 * - Retry cu backoff exponential pe 429 + 5xx
 * - Timeout 30s cu AbortController
 * - Parsing eroare Meta cu cod, subcod, user_msg
 */
async function meta(path, method = "GET", body = null, retries = 3) {
  if (!TOKEN) throw new Error("META_ADS_ACCESS_TOKEN lipsa (probabil server restart necesar).");

  const base    = path.startsWith("http") ? path : `${API}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const opts = {
    method,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${TOKEN}`
    },
    signal: controller.signal
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(base, opts);
    clearTimeout(timeout);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") throw new Error("Timeout: requestul a durat peste 30 secunde");
    // Network errors — retry daca mai sunt incercari
    if (retries > 0) {
      await new Promise(r => setTimeout(r, (4 - retries) * 1000));
      return meta(path, method, body, retries - 1);
    }
    throw new Error(`Retea: ${e.message}`);
  }

  // Retry pe 429 (rate limit) + 5xx (server errors tranzitorii)
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const wait = (4 - retries) * 2000; // 2s, 4s, 6s
    await new Promise(r => setTimeout(r, wait));
    return meta(path, method, body, retries - 1);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Meta API: raspuns non-JSON (HTTP ${res.status})`);
  }

  if (data.error) {
    const code = data.error.code || data.error.error_code || "?";
    const msg  = data.error.error_user_msg || data.error.error_message || data.error.message;
    const sub  = data.error.error_subcode ? ` [sub:${data.error.error_subcode}]` : "";
    throw new Error(`Meta API [${code}]${sub}: ${msg}`);
  }
  return data;
}

/**
 * Fetch cu paginare automata — parcurge cursor.next pana la limit total sau pana la capat.
 * Returneaza { data: [...], total_fetched, has_more }
 */
async function metaPaginated(path, { maxPages = 5, maxItems = 500 } = {}) {
  const allData = [];
  let url = path;
  let pages = 0;

  while (url && pages < maxPages && allData.length < maxItems) {
    const d = await meta(url);
    if (d.data) allData.push(...d.data);
    url = d.paging?.next || null;
    pages++;
    if (allData.length >= maxItems) break;
  }
  return {
    data: allData.slice(0, maxItems),
    total_fetched: allData.length,
    has_more: !!url
  };
}

const ok   = (t) => ({ content: [{ type: "text", text: String(t) }] });
const err  = (e) => ({ content: [{ type: "text", text: `Eroare: ${e.message}` }], isError: true });
const json = (o) => ok(JSON.stringify(o, null, 2));

// Schema reutilizabila — ad_account_id optional in fiecare tool
const accountParam = {
  ad_account_id: z.string().optional().describe(
    "ID cont de publicitate (cu sau fara prefix 'act_'). Daca lipseste, foloseste default-ul din Railway (META_AD_ACCOUNT_ID). Listeaza conturile disponibile cu list_ad_accounts."
  )
};

// ── Server definition ────────────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({ name: "meta-ads-mcp", version: "4.1.0" });

  // ══ ACCOUNTS MULTI-TENANT ═════════════════════════════════════════════════
  server.tool("list_ad_accounts",
    "Listeaza toate conturile de publicitate la care token-ul are acces. Esential pentru agentii cu mai multi clienti. Returneaza ID-uri utilizabile in ad_account_id peste tot.",
    {},
    async () => {
      try {
        const { data } = await metaPaginated(
          `/me/adaccounts?fields=id,name,account_status,currency,timezone_name,amount_spent,business&limit=100`,
          { maxPages: 10, maxItems: 500 }
        );
        if (!data.length) return ok("Niciun cont gasit. Verifica permisiunile token-ului in Business Manager.");

        const s = { 1:"ACTIV", 2:"DEZACTIVAT", 3:"NEPLATIT", 7:"POLITICI", 9:"INCHIS", 100:"PENDING", 101:"INVALID" };
        const lines = data.map(a => {
          const spent = ((a.amount_spent || 0) / 100).toFixed(2);
          const biz   = a.business ? ` | ${a.business.name}` : "";
          return `${a.id} | ${a.name} | ${s[a.account_status] || a.account_status} | ${a.currency} | Cheltuit: ${spent} ${a.currency}${biz}`;
        });
        return ok(`Conturi accesibile (${data.length}):\n${lines.join("\n")}\n\nFoloseste ID-ul (ex: act_123456) ca parametru ad_account_id in orice tool.`);
      } catch (e) { return err(e); }
    }
  );

  // ── CONT ─────────────────────────────────────────────────────────────────
  server.tool("get_account_info",
    "Informatii cont: status, valuta, cheltuieli totale, business manager",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const d = await meta(`/act_${acct}?fields=id,name,account_status,currency,timezone_name,amount_spent,business`);
        const s = { 1:"ACTIV", 2:"DEZACTIVAT", 3:"NEPLATIT", 7:"POLITICI", 9:"INCHIS" };
        return ok([
          `Cont: ${d.name} (${d.id})`,
          `Status: ${s[d.account_status] || d.account_status}`,
          `Valuta: ${d.currency} | Fus orar: ${d.timezone_name}`,
          `Cheltuit total: ${((d.amount_spent||0)/100).toFixed(2)} ${d.currency}`,
          d.business ? `Business: ${d.business.name} (${d.business.id})` : ""
        ].filter(Boolean).join("\n"));
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_pages",
    "Listeaza paginile Facebook. Returneaza page_id necesar pentru create_creative.",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        let pages = [];
        try {
          const { data } = await metaPaginated(`/me/accounts?fields=id,name,category,fan_count&limit=50`);
          pages = data;
        } catch {
          const acct = resolveAccount(ad_account_id);
          const biz = await meta(`/act_${acct}?fields=business`);
          if (biz.business) {
            const { data } = await metaPaginated(`/${biz.business.id}/owned_pages?fields=id,name,category,fan_count&limit=50`);
            pages = data;
          }
        }
        if (!pages.length) return ok("Nicio pagina Facebook gasita. Verifica Business Manager.");
        return ok(`Pagini (${pages.length}):\n${pages.map(p=>`ID: ${p.id} | ${p.name} | ${p.category}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_pixels",
    "Listeaza pixelii Meta. Necesar pentru campanii cu OFFSITE_CONVERSIONS.",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(`/act_${acct}/adspixels?fields=id,name,last_fired_time&limit=25`);
        if (!data.length) return ok("Niciun pixel gasit. Creeaza unul in Meta Events Manager.");
        return ok(`Pixeli (${data.length}):\n${data.map(x=>{
          const last = x.last_fired_time ? new Date(x.last_fired_time*1000).toLocaleDateString("ro-RO") : "Niciodata";
          return `ID: ${x.id} | ${x.name} | Ultimul foc: ${last}`;
        }).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_instagram_accounts",
    "Listeaza conturile Instagram conectate.",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(`/act_${acct}/instagram_accounts?fields=id,username&limit=25`);
        if (!data.length) return ok("Niciun cont Instagram conectat.");
        return ok(`Instagram (${data.length}):\n${data.map(x=>`ID: ${x.id} | @${x.username}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── CITIRE CAMPANII ───────────────────────────────────────────────────────
  server.tool("list_campaigns",
    "Listeaza campaniile din cont cu status, obiectiv si buget",
    {
      ...accountParam,
      status: z.enum(["ACTIVE","PAUSED","ARCHIVED","ALL"]).default("ALL"),
      max_results: z.number().default(100).describe("Numar max de campanii (default 100, max 500 via paginare)")
    },
    async ({ ad_account_id, status, max_results }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const f = status === "ALL" ? "" : `&effective_status=["${status}"]`;
        const { data, has_more } = await metaPaginated(
          `/act_${acct}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget${f}&limit=100`,
          { maxItems: Math.min(max_results, 500) }
        );
        if (!data.length) return ok("Nu exista campanii.");
        const lines = data.map(x=>{
          const b = x.daily_budget ? `${(x.daily_budget/100).toFixed(2)}$/zi` : x.lifetime_budget ? `${(x.lifetime_budget/100).toFixed(2)}$ total` : "-";
          return `ID: ${x.id} | ${x.name} | ${x.status} | ${x.objective} | ${b}`;
        });
        const tail = has_more ? `\n\n(Mai multe disponibile — creste max_results pentru a le vedea)` : "";
        return ok(`Campanii (${data.length}):\n${lines.join("\n")}${tail}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_adsets",
    "Listeaza Ad Set-urile dintr-o campanie cu buget, targeting si status",
    { campaign_id: z.string().describe("ID-ul campaniei") },
    async ({ campaign_id }) => {
      try {
        const { data } = await metaPaginated(
          `/${campaign_id}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal&limit=100`,
          { maxItems: 500 }
        );
        return json(data);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_ads",
    "Listeaza Ad-urile dintr-un Ad Set cu status si creative",
    { adset_id: z.string().describe("ID-ul Ad Set-ului") },
    async ({ adset_id }) => {
      try {
        const { data } = await metaPaginated(
          `/${adset_id}/ads?fields=id,name,status,creative{id,name}&limit=100`,
          { maxItems: 500 }
        );
        return json(data);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_images",
    "Listeaza imaginile uploadate in cont. Reutilizeaza hash-ul pentru creative noi.",
    { ...accountParam, limit: z.number().default(25) },
    async ({ ad_account_id, limit }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(`/act_${acct}/adimages?fields=hash,name,url,width,height,status&limit=${limit}`);
        if (!data.length) return ok("Nu exista imagini uploadate.");
        return ok(`Imagini (${data.length}):\n${data.map(x=>`Hash: ${x.hash} | ${x.name||"fara_nume"} | ${x.width}x${x.height}px`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── INSIGHTS ─────────────────────────────────────────────────────────────
  server.tool("get_all_insights",
    "Raport complet CPL/ROAS pentru toate campaniile. Foloseste pentru monitorizare zilnica.",
    {
      ...accountParam,
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      level: z.enum(["campaign","adset","ad"]).default("campaign")
    },
    async ({ ad_account_id, date_preset, level }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const fields = "campaign_name,campaign_id,adset_name,adset_id,spend,impressions,clicks,reach,frequency,ctr,cpc,actions,cost_per_action_type";
        const { data } = await metaPaginated(
          `/act_${acct}/insights?fields=${fields}&date_preset=${date_preset}&level=${level}&limit=200`,
          { maxItems: 1000 }
        );
        if (!data.length) return ok("Nu exista date pentru perioada selectata.");
        return json(data);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_insights",
    "Analiza detaliata pentru o campanie, ad set sau ad. Suporta segmentare pe varsta, gen, plasament.",
    {
      object_id: z.string().describe("ID campanie, ad set sau ad"),
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      breakdown: z.enum(["none","age","gender","country","placement","device_platform"]).default("none")
    },
    async ({ object_id, date_preset, breakdown }) => {
      try {
        const fields = "spend,impressions,clicks,reach,frequency,ctr,cpc,actions,cost_per_action_type";
        let url = `/${object_id}/insights?fields=${fields}&date_preset=${date_preset}`;
        if (breakdown !== "none") url += `&breakdowns=${breakdown}`;
        const d = await meta(url);
        return json(d.data || d);
      } catch (e) { return err(e); }
    }
  );

  server.tool("analyze_wasted_spend",
    "Identifica ad set-urile care cheltuiesc fara conversii. Esential pentru optimizarea CPL.",
    {
      ...accountParam,
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_7d"),
      cpl_threshold: z.number().default(3).describe("Prag CPL in dolari — ad set-urile peste acest prag sunt ineficiente")
    },
    async ({ ad_account_id, date_preset, cpl_threshold }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const fields = "campaign_name,adset_name,spend,actions,cost_per_action_type,impressions";
        const { data } = await metaPaginated(
          `/act_${acct}/insights?fields=${fields}&date_preset=${date_preset}&level=adset&limit=200`,
          { maxItems: 500 }
        );
        const wasted = [], good = [];
        for (const r of data) {
          const spend = parseFloat(r.spend || 0);
          const leads = parseInt((r.actions||[]).find(a=>["lead","onsite_conversion.lead_grouped"].includes(a.action_type))?.value || 0);
          const cpl = leads > 0 ? spend / leads : null;
          const item = { campanie: r.campaign_name, adset: r.adset_name, spend: `$${spend.toFixed(2)}`, leads, cpl: cpl ? `$${cpl.toFixed(2)}` : "0 leads" };
          (cpl === null || cpl > cpl_threshold ? wasted : good).push(item);
        }
        const total = wasted.reduce((s,r) => s + parseFloat(r.spend.slice(1)), 0);
        let out = `=== CHELTUIELI IROSITE (prag: $${cpl_threshold}) ===\nTotal ineficient: $${total.toFixed(2)}\n\nINEFICIENTE (${wasted.length}):\n`;
        wasted.forEach(r => out += `  ✕ ${r.adset} | ${r.spend} | ${r.leads} leads | CPL: ${r.cpl}\n`);
        out += `\nEFICIENTE (${good.length}):\n`;
        good.forEach(r => out += `  ✓ ${r.adset} | ${r.spend} | ${r.leads} leads | CPL: ${r.cpl}\n`);
        return ok(out);
      } catch (e) { return err(e); }
    }
  );

  server.tool("detect_creative_fatigue",
    "Detecteaza reclame cu frecventa ridicata si CTR in scadere.",
    {
      ...accountParam,
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_14d"),
      frequency_threshold: z.number().default(2.5).describe("Frecventa peste care creativul e considerat obosit")
    },
    async ({ ad_account_id, date_preset, frequency_threshold }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const fields = "ad_name,ad_id,campaign_name,adset_name,spend,frequency,ctr,reach";
        const { data } = await metaPaginated(
          `/act_${acct}/insights?fields=${fields}&date_preset=${date_preset}&level=ad&limit=200`,
          { maxItems: 500 }
        );
        const fatigued = data.filter(r=>parseFloat(r.frequency||0)>=frequency_threshold).sort((a,b)=>parseFloat(b.frequency)-parseFloat(a.frequency));
        const fine = data.filter(r=>parseFloat(r.frequency||0)<frequency_threshold);
        let out = `=== FATIGUE CREATIVE (prag: ${frequency_threshold}) ===\n\nOBOSITE (${fatigued.length}):\n`;
        fatigued.forEach(r => out += `  ! ${r.ad_name}\n    ${r.campaign_name} | Frecventa: ${parseFloat(r.frequency).toFixed(1)} | CTR: ${parseFloat(r.ctr||0).toFixed(2)}%\n\n`);
        out += `OK (${fine.length}) — frecventa sub prag\n`;
        return ok(out);
      } catch (e) { return err(e); }
    }
  );

  // Tool NOU: get_campaign_full — agregă tot într-un apel
  server.tool("get_campaign_full",
    "Returneaza campanie + ad set-uri + ad-uri + insights intr-un singur apel. Economiseste context window vs 4 apeluri separate. Ideal pentru audit rapid al unei campanii.",
    {
      campaign_id: z.string().describe("ID-ul campaniei"),
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      include_ads: z.boolean().default(true).describe("Daca sa includa lista de ad-uri per ad set (poate creste output-ul)")
    },
    async ({ campaign_id, date_preset, include_ads }) => {
      try {
        // 1. Campanie
        const campaign = await meta(`/${campaign_id}?fields=id,name,status,objective,daily_budget,lifetime_budget,special_ad_categories,created_time,start_time,stop_time`);

        // 2. Ad sets
        const { data: adsets } = await metaPaginated(
          `/${campaign_id}/adsets?fields=id,name,status,daily_budget,optimization_goal,billing_event,bid_strategy,targeting&limit=100`,
          { maxItems: 200 }
        );

        // 3. Insights per ad set + overall
        const fields = "spend,impressions,clicks,reach,frequency,ctr,cpc,cpm,actions,cost_per_action_type";
        const [overallInsights, adsetInsights] = await Promise.all([
          meta(`/${campaign_id}/insights?fields=${fields}&date_preset=${date_preset}`).catch(() => ({ data: [] })),
          meta(`/${campaign_id}/insights?fields=${fields},adset_id,adset_name&date_preset=${date_preset}&level=adset&limit=200`).catch(() => ({ data: [] }))
        ]);

        const insightsByAdset = {};
        for (const row of (adsetInsights.data || [])) {
          insightsByAdset[row.adset_id] = row;
        }

        // 4. Ads per adset (optional)
        let adsByAdset = {};
        if (include_ads) {
          const adPromises = adsets.map(as =>
            metaPaginated(`/${as.id}/ads?fields=id,name,status,creative{id,name,thumbnail_url}&limit=50`, { maxItems: 100 })
              .then(r => ({ adset_id: as.id, ads: r.data }))
              .catch(() => ({ adset_id: as.id, ads: [] }))
          );
          const results = await Promise.all(adPromises);
          for (const r of results) adsByAdset[r.adset_id] = r.ads;
        }

        // 5. Asamblare rezultat
        const result = {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            objective: campaign.objective,
            daily_budget: campaign.daily_budget ? `$${(campaign.daily_budget/100).toFixed(2)}/zi` : null,
            lifetime_budget: campaign.lifetime_budget ? `$${(campaign.lifetime_budget/100).toFixed(2)} total` : null,
            special_ad_categories: campaign.special_ad_categories || []
          },
          performance_overall: (overallInsights.data || [])[0] || null,
          adsets: adsets.map(as => ({
            id: as.id,
            name: as.name,
            status: as.status,
            daily_budget: as.daily_budget ? `$${(as.daily_budget/100).toFixed(2)}/zi` : null,
            optimization_goal: as.optimization_goal,
            billing_event: as.billing_event,
            bid_strategy: as.bid_strategy,
            geo: as.targeting?.geo_locations?.countries || [],
            age: `${as.targeting?.age_min || "?"}-${as.targeting?.age_max || "?"}`,
            genders: as.targeting?.genders || [],
            performance: insightsByAdset[as.id] || null,
            ads: include_ads ? (adsByAdset[as.id] || []) : undefined
          })),
          period: date_preset
        };

        return json(result);
      } catch (e) { return err(e); }
    }
  );

  // ── CREARE CAMPANIE ───────────────────────────────────────────────────────
  server.tool("create_campaign",
    "Pas 1/5: Creeaza o campanie noua (PAUSED). Returneaza campaign_id pentru create_adset.",
    {
      ...accountParam,
      name: z.string().describe("Numele campaniei"),
      objective: z.enum(["OUTCOME_LEADS","OUTCOME_SALES","OUTCOME_TRAFFIC","OUTCOME_AWARENESS","OUTCOME_ENGAGEMENT","OUTCOME_APP_PROMOTION"]).describe("Obiectivul campaniei"),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD (1000=$10). Nu combina cu lifetime_budget. Lasa gol daca vrei buget per ad set."),
      lifetime_budget: z.number().optional().describe("Buget total in CENTI USD. Necesita stop_time."),
      stop_time: z.string().optional().describe("Data sfarsit ISO 8601. Necesar cu lifetime_budget."),
      special_ad_categories: z.array(z.string()).default([]).describe("Categorii speciale obligatorii: CREDIT, EMPLOYMENT, HOUSING, ISSUES_ELECTIONS_POLITICS. Targeting restrictionat pentru aceste categorii.")
    },
    async ({ ad_account_id, name, objective, daily_budget, lifetime_budget, stop_time, special_ad_categories }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        if (daily_budget && lifetime_budget) throw new Error("Foloseste fie daily_budget fie lifetime_budget, nu ambele.");
        if (lifetime_budget && !stop_time) throw new Error("lifetime_budget necesita stop_time.");
        const body = { name, objective, status: "PAUSED", special_ad_categories };
        if (daily_budget)    body.daily_budget = daily_budget;
        if (lifetime_budget) body.lifetime_budget = lifetime_budget;
        if (stop_time)       body.stop_time = stop_time;
        const d = await meta(`/act_${acct}/campaigns`, "POST", body);
        return ok(`Campanie creata!\nID: ${d.id}\nNume: ${name}\nObiectiv: ${objective}\nStatus: PAUSED\n\nPasul urmator: create_adset cu campaign_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_adset",
    "Pas 2/5: Creeaza un Ad Set cu targeting complet. Returneaza adset_id pentru create_ad.",
    {
      ...accountParam,
      campaign_id: z.string().describe("ID campanie din create_campaign"),
      name: z.string().describe("Numele Ad Set-ului"),
      advantage_audience: z.union([z.literal(0), z.literal(1)]).describe("OBLIGATORIU (Meta API v25). 0=targeting MANUAL exact (varsta/gen/interese respectate strict). 1=Advantage+ AI (Meta extinde automat). Alege 0 pentru audienta specifica, 1 pentru lead gen broad."),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD (1000=$10). Lasa gol daca campania are CBO."),
      age_min: z.number().default(18).describe("Varsta minima (18-65)"),
      age_max: z.number().default(65).describe("Varsta maxima (18-65)"),
      genders: z.array(z.number()).default([1,2]).describe("1=Barbati 2=Femei [1,2]=Ambele"),
      countries: z.array(z.string()).default(["RO"]).describe("Coduri ISO 2 (ex: ['RO','MD'])"),
      optimization_goal: z.enum(["LEAD_GENERATION","LINK_CLICKS","IMPRESSIONS","REACH","OFFSITE_CONVERSIONS","LANDING_PAGE_VIEWS","THRUPLAY"]).default("LEAD_GENERATION"),
      billing_event: z.enum(["IMPRESSIONS","LINK_CLICKS","THRUPLAY"]).default("IMPRESSIONS"),
      bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP","LOWEST_COST_WITH_BID_CAP","COST_CAP"]).optional().describe("Lasa gol pentru lowest cost fara cap (default Meta). Specifica doar daca vrei LOWEST_COST_WITH_BID_CAP sau COST_CAP (necesita bid_amount)."),
      bid_amount: z.number().optional().describe("Bid in CENTI USD. Necesar pentru LOWEST_COST_WITH_BID_CAP si COST_CAP."),
      interest_ids: z.array(z.string()).optional().describe("ID-uri interese din search_interests. Nota: cu advantage_audience=1, Meta poate extinde audienta."),
      excluded_interest_ids: z.array(z.string()).optional().describe("ID-uri interese de EXCLUS din targeting."),
      excluded_geo_countries: z.array(z.string()).optional().describe("Coduri ISO 2 de EXCLUS geografic."),
      excluded_geo_regions: z.array(z.object({ key: z.string() })).optional().describe("Regiuni/judete de EXCLUS. Key din search_locations."),
      excluded_geo_cities: z.array(z.object({ key: z.string(), radius: z.number().optional(), distance_unit: z.string().optional() })).optional().describe("Orase de EXCLUS. Key din search_locations."),
      excluded_custom_audience_ids: z.array(z.string()).optional().describe("ID-uri audionte custom de EXCLUS. Ex: clientii existenti pentru prospecting curat."),
      publisher_platforms: z.array(z.enum(["facebook","instagram","audience_network","messenger"])).optional().describe("Platformele unde apare reclama. Gol = toate."),
      facebook_positions: z.array(z.enum(["feed","right_hand_column","marketplace","story","search","reels","instream_video"])).optional(),
      instagram_positions: z.array(z.enum(["stream","story","explore","reels","profile_feed","ig_search"])).optional(),
      frequency_cap: z.number().optional().describe("Limita max afisari per user. ACCEPTAT DOAR pentru optimization_goal REACH sau IMPRESSIONS."),
      frequency_cap_period: z.enum(["DAILY","WEEKLY","MONTHLY"]).default("WEEKLY").optional(),
      pixel_id: z.string().optional().describe("ID pixel din list_pixels. Necesar pentru OFFSITE_CONVERSIONS."),
      end_time: z.string().optional().describe("Data sfarsit ISO 8601"),
      is_adset_budget_sharing_enabled: z.boolean().default(true).describe("v24.0+: Permite partajarea bugetului intre ad set-uri.")
    },
    async (args) => {
      try {
        const {
          ad_account_id, campaign_id, name, advantage_audience, daily_budget, age_min, age_max,
          genders, countries, optimization_goal, billing_event, bid_strategy, bid_amount, interest_ids,
          pixel_id, end_time, is_adset_budget_sharing_enabled,
          publisher_platforms, facebook_positions, instagram_positions,
          frequency_cap, frequency_cap_period,
          excluded_interest_ids, excluded_geo_countries, excluded_geo_regions,
          excluded_geo_cities, excluded_custom_audience_ids
        } = args;

        const acct = resolveAccount(ad_account_id);
        const warnings = [];

        const targeting = {
          age_min, age_max, genders,
          geo_locations: { countries },
          targeting_automation: { advantage_audience }
        };
        if (interest_ids?.length) {
          targeting.flexible_spec = [{ interests: interest_ids.map(id => ({ id })) }];
        }
        const body = {
          campaign_id, name, targeting,
          optimization_goal, billing_event,
          status: "PAUSED"
        };
        if (bid_strategy) body.bid_strategy = bid_strategy;
        if (daily_budget) {
          body.daily_budget = daily_budget;
          body.is_adset_budget_sharing_enabled = is_adset_budget_sharing_enabled;
        }
        if (bid_amount)   body.bid_amount = bid_amount;
        if (end_time)     body.end_time = end_time;
        if (pixel_id && optimization_goal === "OFFSITE_CONVERSIONS") {
          body.promoted_object = { pixel_id, custom_event_type: "LEAD" };
        }

        // Exclusions
        const exclusions = {};
        if (excluded_custom_audience_ids?.length) {
          exclusions.custom_audiences = excluded_custom_audience_ids.map(id => ({ id }));
        }
        if (excluded_interest_ids?.length) {
          exclusions.interests = excluded_interest_ids.map(id => ({ id }));
        }
        const excluded_geo = {};
        if (excluded_geo_countries?.length)  excluded_geo.countries = excluded_geo_countries;
        if (excluded_geo_regions?.length)    excluded_geo.regions   = excluded_geo_regions;
        if (excluded_geo_cities?.length)     excluded_geo.cities    = excluded_geo_cities;
        if (Object.keys(excluded_geo).length) exclusions.geo_locations = excluded_geo;
        if (Object.keys(exclusions).length) body.targeting.exclusions = exclusions;

        // Placements
        if (publisher_platforms?.length) {
          body.targeting.publisher_platforms = publisher_platforms;
          if (facebook_positions?.length)  body.targeting.facebook_positions = facebook_positions;
          if (instagram_positions?.length) body.targeting.instagram_positions = instagram_positions;
        }

        // Frequency cap — valabil DOAR pentru REACH si IMPRESSIONS
        if (frequency_cap) {
          if (["REACH","IMPRESSIONS"].includes(optimization_goal)) {
            body.frequency_control_specs = [{
              event: "IMPRESSIONS",
              interval_days: frequency_cap_period === "DAILY" ? 1 : frequency_cap_period === "WEEKLY" ? 7 : 30,
              max_frequency: Math.min(Math.max(1, frequency_cap), 90)
            }];
          } else {
            warnings.push(`⚠ frequency_cap IGNORAT — compatibil doar cu optimization_goal=REACH sau IMPRESSIONS (actual: ${optimization_goal}).`);
          }
        }

        const d = await meta(`/act_${acct}/adsets`, "POST", body);
        const bStr = daily_budget ? `${(daily_budget/100).toFixed(2)}$/zi` : "din campanie";
        const warnBlock = warnings.length ? `\n\n${warnings.join("\n")}` : "";
        return ok(`Ad Set creat!\nID: ${d.id}\nNume: ${name}\nBuget: ${bStr}\nAudienta: ${advantage_audience===0?"Manual":"Advantage+ AI"}\nStatus: PAUSED${warnBlock}\n\nPasul urmator: upload_image sau create_creative cu adset_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_image",
    "Pas 3a/5: Uploadeaza imagine din URL. Returneaza image_hash pentru create_creative.\nGoogle Drive: Share > Anyone with link → https://drive.google.com/uc?export=download&id=FILE_ID",
    {
      ...accountParam,
      image_url: z.string().url().describe("URL public direct al imaginii")
    },
    async ({ ad_account_id, image_url }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const d = await meta(`/act_${acct}/adimages`, "POST", { url: image_url });
        const img = Object.values(d.images || {})[0];
        if (!img) throw new Error("Upload esuat. Verifica ca URL-ul returneaza direct imaginea si nu o pagina HTML.");
        return ok(`Imagine uploadata!\nHash: ${img.hash}\nDimensiune: ${img.width}x${img.height}px\n\nPasul urmator: create_creative cu image_hash="${img.hash}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_video",
    "Pas 3b/5: Uploadeaza video din URL. Returneaza video_id pentru create_video_creative.",
    {
      ...accountParam,
      video_url: z.string().url().describe("URL public direct al fisierului video (MP4, max 4GB)"),
      title: z.string().default("Video Ad")
    },
    async ({ ad_account_id, video_url, title }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const d = await meta(`/act_${acct}/advideos`, "POST", { file_url: video_url, title });
        return ok(`Video uploadat!\nID: ${d.id}\nTitlu: ${title}\n\nPasul urmator: create_video_creative cu video_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_creative",
    "Pas 4a/5: Creeaza creative cu imagine. Returneaza creative_id pentru create_ad.",
    {
      ...accountParam,
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      image_hash: z.string().describe("Hash din upload_image sau list_images"),
      message: z.string().max(500).describe("Textul principal (suporta emoji si newline)"),
      headline: z.string().max(40).describe("Titlul (max 40 caractere)"),
      description: z.string().max(30).optional(),
      link_url: z.string().url(),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","GET_QUOTE","APPLY_NOW","DOWNLOAD","SUBSCRIBE","GET_OFFER","WATCH_MORE"]).default("LEARN_MORE"),
      instagram_actor_id: z.string().optional().describe("ID cont Instagram din list_instagram_accounts")
    },
    async ({ ad_account_id, name, page_id, image_hash, message, headline, description, link_url, cta_type, instagram_actor_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const link_data = { image_hash, link: link_url, message, name: headline, description: description||"", call_to_action: { type: cta_type, value: { link: link_url } } };
        const spec = { page_id, link_data };
        if (instagram_actor_id) spec.instagram_actor_id = instagram_actor_id;
        const d = await meta(`/act_${acct}/adcreatives`, "POST", { name, object_story_spec: spec });
        return ok(`Creative creat!\nID: ${d.id}\nNume: ${name}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_video_creative",
    "Pas 4b/5: Creeaza creative cu video. Thumbnail preluat automat din video daca nu e specificat.",
    {
      ...accountParam,
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      video_id: z.string().describe("ID video din upload_video"),
      message: z.string().max(500),
      headline: z.string().max(40),
      link_url: z.string().url(),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","WATCH_MORE","DOWNLOAD"]).default("LEARN_MORE"),
      thumbnail_url: z.string().url().optional().describe("URL thumbnail custom. Daca lipseste, serverul il preia automat din video.")
    },
    async ({ ad_account_id, name, page_id, video_id, message, headline, link_url, cta_type, thumbnail_url }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        let thumb = thumbnail_url;
        if (!thumb) {
          try {
            const td = await meta(`/${video_id}/thumbnails?fields=uri,is_preferred`);
            const thumbs = td.data || [];
            const pref = thumbs.find(t => t.is_preferred) || thumbs[0];
            if (pref?.uri) thumb = pref.uri;
          } catch { /* continua fara thumbnail */ }
        }
        const video_data = { video_id, message, title: headline, call_to_action: { type: cta_type, value: { link: link_url } } };
        if (thumb) video_data.image_url = thumb;
        const d = await meta(`/act_${acct}/adcreatives`, "POST", { name, object_story_spec: { page_id, video_data } });
        const tInfo = thumb ? (thumbnail_url ? "thumbnail custom" : "thumbnail auto din video") : "fara thumbnail";
        return ok(`Creative video creat!\nID: ${d.id}\nThumbnail: ${tInfo}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_carousel_creative",
    "Pas 4c/5: Creeaza creative carousel (2-10 carduri). Ideal pentru mai multe produse.",
    {
      ...accountParam,
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      message: z.string().max(500),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","GET_QUOTE"]).default("LEARN_MORE"),
      cards: z.array(z.object({
        image_hash: z.string(),
        headline: z.string().max(40),
        description: z.string().max(30).optional(),
        link_url: z.string().url()
      })).min(2).max(10).describe("Cardurile carousel (minim 2, maxim 10)")
    },
    async ({ ad_account_id, name, page_id, message, cta_type, cards }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const child_attachments = cards.map(c => ({
          link: c.link_url, image_hash: c.image_hash, name: c.headline,
          description: c.description||"", call_to_action: { type: cta_type, value: { link: c.link_url } }
        }));
        const d = await meta(`/act_${acct}/adcreatives`, "POST", { name, object_story_spec: { page_id, link_data: { message, link: cards[0].link_url, child_attachments, multi_share_optimized: true } } });
        return ok(`Creative carousel creat!\nID: ${d.id}\nCarduri: ${cards.length}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_ad",
    "Pas 5/5: Creeaza Ad-ul final — leaga Ad Set-ul cu Creative-ul. Campania ramane PAUSED pana o activezi manual.",
    {
      ...accountParam,
      adset_id: z.string().describe("ID Ad Set din create_adset"),
      creative_id: z.string().describe("ID creative din create_creative / create_video_creative / create_carousel_creative"),
      name: z.string().describe("Numele Ad-ului"),
      multi_advertiser_ads: z.boolean().default(true).describe("Multi-advertiser ads: true=activat, false=dezactivat (control complet asupra plasamentului)."),
      url_tags: z.string().optional().describe("Parametri UTM pentru tracking (ex: 'utm_source=facebook&utm_medium=paid&utm_campaign=test')"),
      conversion_domain: z.string().optional().describe("Domeniul de conversie (ex: 'exemplu.ro'). Recomandat pentru campanii cu pixel.")
    },
    async ({ ad_account_id, adset_id, creative_id, name, multi_advertiser_ads, url_tags, conversion_domain }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const body = {
          adset_id,
          creative: { creative_id },
          name,
          status: "PAUSED",
          multi_advertiser_eligibility: multi_advertiser_ads ? "eligible" : "not_eligible"
        };
        if (url_tags)          body.creative = { ...body.creative, url_tags };
        if (conversion_domain) body.conversion_domain = conversion_domain;
        const d = await meta(`/act_${acct}/ads`, "POST", body);
        return ok(`Ad creat cu succes!\nID: ${d.id}\nNume: ${name}\nStatus: PAUSED\nMulti-advertiser: ${multi_advertiser_ads ? "activat" : "dezactivat"}\n\nActiveaza cu update_campaign_status cand esti gata sa difuzezi.`);
      } catch (e) { return err(e); }
    }
  );

  // ── MANAGEMENT ────────────────────────────────────────────────────────────
  server.tool("update_campaign_status",
    "Activeaza sau pauzeaza o campanie",
    { campaign_id: z.string(), status: z.enum(["ACTIVE","PAUSED"]) },
    async ({ campaign_id, status }) => {
      try {
        await meta(`/${campaign_id}`, "POST", { status });
        return ok(`${status==="ACTIVE"?"▶":"⏸"} Campania ${campaign_id} → ${status}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("update_campaign_budget",
    "Modifica bugetul zilnic al unei campanii (in CENTI USD)",
    { campaign_id: z.string(), daily_budget: z.number().describe("Buget zilnic in CENTI USD (2000=$20)") },
    async ({ campaign_id, daily_budget }) => {
      try {
        await meta(`/${campaign_id}`, "POST", { daily_budget });
        return ok(`Buget actualizat: ${(daily_budget/100).toFixed(2)}$/zi pentru campania ${campaign_id}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("update_adset",
    "Modifica un Ad Set: status, buget, bid, targeting (tari/varsta/gen/interese), nume sau programare",
    {
      adset_id: z.string().describe("ID-ul Ad Set-ului de modificat"),
      status: z.enum(["ACTIVE","PAUSED"]).optional().describe("Activeaza sau pauzeaza ad set-ul"),
      name: z.string().optional().describe("Noul nume al Ad Set-ului"),
      daily_budget: z.number().optional().describe("Noul buget zilnic in CENTI USD (ex: 2000=$20)"),
      bid_amount: z.number().optional().describe("Noul bid in CENTI USD"),
      end_time: z.string().optional().describe("Data de sfarsit ISO 8601"),
      countries: z.array(z.string()).optional().describe("Inlocuieste targetingul geografic"),
      age_min: z.number().optional().describe("Noua varsta minima (18-65)"),
      age_max: z.number().optional().describe("Noua varsta maxima (18-65)"),
      genders: z.array(z.number()).optional().describe("1=Barbati 2=Femei [1,2]=Ambele"),
      interest_ids: z.array(z.string()).optional().describe("Inlocuieste interesele cu aceste ID-uri"),
      excluded_interest_ids: z.array(z.string()).optional().describe("Interese de EXCLUS din targeting"),
      excluded_geo_countries: z.array(z.string()).optional().describe("Tari de EXCLUS"),
      excluded_custom_audience_ids: z.array(z.string()).optional().describe("Audionte custom de EXCLUS")
    },
    async ({ adset_id, status, name, daily_budget, bid_amount, end_time, countries, age_min, age_max, genders, interest_ids, excluded_interest_ids, excluded_geo_countries, excluded_custom_audience_ids }) => {
      try {
        const body = {};
        if (status)       body.status = status;
        if (name)         body.name = name;
        if (daily_budget) body.daily_budget = daily_budget;
        if (bid_amount)   body.bid_amount = bid_amount;
        if (end_time)     body.end_time = end_time;
        if (countries || age_min !== undefined || age_max !== undefined || genders || interest_ids ||
            excluded_interest_ids || excluded_geo_countries || excluded_custom_audience_ids) {
          const current = await meta(`/${adset_id}?fields=targeting`);
          const targeting = { ...(current.targeting || {}) };
          // Preserva targeting_automation existent
          if (!targeting.targeting_automation && current.targeting?.targeting_automation) {
            targeting.targeting_automation = current.targeting.targeting_automation;
          }
          if (countries)             targeting.geo_locations = { ...targeting.geo_locations, countries };
          if (age_min !== undefined) targeting.age_min = age_min;
          if (age_max !== undefined) targeting.age_max = age_max;
          if (genders)               targeting.genders = genders;
          if (interest_ids?.length)  targeting.flexible_spec = [{ interests: interest_ids.map(id => ({ id })) }];
          // Exclusions
          const excl = { ...(targeting.exclusions || {}) };
          if (excluded_interest_ids?.length)        excl.interests        = excluded_interest_ids.map(id => ({ id }));
          if (excluded_geo_countries?.length)       excl.geo_locations    = { ...(excl.geo_locations||{}), countries: excluded_geo_countries };
          if (excluded_custom_audience_ids?.length) excl.custom_audiences = excluded_custom_audience_ids.map(id => ({ id }));
          if (Object.keys(excl).length) targeting.exclusions = excl;
          body.targeting = targeting;
        }
        if (!Object.keys(body).length) return ok("Nicio modificare specificata.");
        await meta(`/${adset_id}`, "POST", body);
        return ok(`Ad Set ${adset_id} actualizat.\nCampuri modificate: ${Object.keys(body).join(", ")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("pause_ad",
    "Pauzeaza sau activeaza un Ad individual",
    { ad_id: z.string(), status: z.enum(["ACTIVE","PAUSED"]) },
    async ({ ad_id, status }) => {
      try {
        await meta(`/${ad_id}`, "POST", { status });
        return ok(`${status==="ACTIVE"?"▶":"⏸"} Ad ${ad_id} → ${status}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("update_ad",
    "Modifica un Ad existent: status, nume, multi-advertiser ads, conversion domain, URL tags. NOTA: Meta API nu permite schimbarea creative-ului unui ad existent — pentru creative nou, creeaza ad nou cu create_ad.",
    {
      ad_id: z.string().describe("ID-ul Ad-ului de modificat"),
      status: z.enum(["ACTIVE","PAUSED"]).optional().describe("Activeaza sau pauzeaza ad-ul"),
      name: z.string().optional().describe("Noul nume al Ad-ului"),
      multi_advertiser_ads: z.boolean().optional().describe("Multi-advertiser ads: true=activat, false=dezactivat."),
      conversion_domain: z.string().optional().describe("Actualizeaza domeniul de conversie (ex: 'exemplu.ro')"),
      url_tags: z.string().optional().describe("Parametri UTM pentru tracking")
    },
    async ({ ad_id, status, name, multi_advertiser_ads, conversion_domain, url_tags }) => {
      try {
        const body = {};
        if (status)      body.status = status;
        if (name)        body.name = name;
        if (multi_advertiser_ads !== undefined) body.multi_advertiser_eligibility = multi_advertiser_ads ? "eligible" : "not_eligible";
        if (conversion_domain) body.conversion_domain = conversion_domain;
        if (url_tags) body.url_tags = url_tags;
        if (!Object.keys(body).length) return ok("Nicio modificare specificata.");
        await meta(`/${ad_id}`, "POST", body);
        const changes = Object.keys(body).map(k => k === "multi_advertiser_eligibility" ? `multi_advertiser: ${body[k]}` : k).join(", ");
        return ok(`Ad ${ad_id} actualizat.\nCampuri modificate: ${changes}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("duplicate_campaign",
    "Duplica o campanie existenta recreand-o cu aceleasi setari. Raporteaza erorile de copiere (nu le ascunde).",
    {
      ...accountParam,
      campaign_id: z.string().describe("ID campanie de copiat"),
      new_name: z.string().describe("Numele noii campanii")
    },
    async ({ ad_account_id, campaign_id, new_name }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const orig = await meta(`/${campaign_id}?fields=name,objective,daily_budget,lifetime_budget,special_ad_categories,stop_time`);
        const body = { name: new_name, objective: orig.objective, status: "PAUSED", special_ad_categories: orig.special_ad_categories||[] };
        if (orig.daily_budget)    body.daily_budget = parseInt(orig.daily_budget);
        if (orig.lifetime_budget) body.lifetime_budget = parseInt(orig.lifetime_budget);
        if (orig.stop_time)       body.stop_time = orig.stop_time;
        const d = await meta(`/act_${acct}/campaigns`, "POST", body);

        const adsetsResp = await meta(`/${campaign_id}/adsets?fields=name,daily_budget,targeting,optimization_goal,billing_event,bid_strategy&limit=50`);
        const adsets = adsetsResp.data || [];
        let copied = 0;
        const failures = [];
        for (const as of adsets) {
          try {
            const tgt = { ...(as.targeting || {}) };
            if (!tgt.targeting_automation) tgt.targeting_automation = { advantage_audience: 0 };
            const ab = { campaign_id: d.id, name: as.name, targeting: tgt, optimization_goal: as.optimization_goal, billing_event: as.billing_event, status: "PAUSED" };
            if (as.bid_strategy) ab.bid_strategy = as.bid_strategy;
            if (as.daily_budget) ab.daily_budget = parseInt(as.daily_budget);
            await meta(`/act_${acct}/adsets`, "POST", ab);
            copied++;
          } catch (e) {
            failures.push(`  ✗ ${as.name}: ${e.message}`);
          }
        }
        const failBlock = failures.length ? `\n\nErori la copiere:\n${failures.join("\n")}` : "";
        return ok(`Campanie duplicata!\nID nou: ${d.id}\nNume: ${new_name}\nAd Sets copiate: ${copied}/${adsets.length}${failBlock}`);
      } catch (e) { return err(e); }
    }
  );

  // ── TARGETING ─────────────────────────────────────────────────────────────
  server.tool("search_interests",
    "Cauta interese pentru targeting. NOTA: Din oct 2025 interesele sunt consolidate in categorii mai largi. Interesele vechi nu functioneaza din ian 2026.",
    {
      query: z.string().describe("Termen de cautat (ex: fitness, imobiliare, antreprenoriat)"),
      limit: z.number().default(15),
      locale: z.string().default("en_US").describe("Limba rezultatelor (en_US pentru engleza, ro_RO pentru romana)")
    },
    async ({ query, limit, locale }) => {
      try {
        const d = await meta(`/search?type=adinterest&q=${encodeURIComponent(query)}&limit=${limit}&locale=${locale}`);
        const items = d.data || [];
        if (!items.length) return ok(`Niciun interes gasit pentru "${query}".\nIncearca termeni mai generali sau in engleza. Interesele specifice au fost consolidate din oct 2025.`);
        const lines = items.map(i => `ID: ${i.id} | ${i.name} | Audienta: ${(i.audience_size_lower_bound||0).toLocaleString()} - ${(i.audience_size_upper_bound||0).toLocaleString()}`);
        return ok(`Interese pentru "${query}" (${items.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("search_locations",
    "Cauta locatii pentru targeting geografic: tari, regiuni, orase",
    {
      query: z.string().describe("Numele locatiei (ex: Bucuresti, Cluj, Romania)"),
      location_types: z.array(z.enum(["country","region","city","zip"])).default(["country","region","city"])
    },
    async ({ query, location_types }) => {
      try {
        const types = location_types.map(t=>`"${t}"`).join(",");
        const d = await meta(`/search?type=adgeolocation&q=${encodeURIComponent(query)}&location_types=[${types}]&limit=15`);
        const items = d.data || [];
        if (!items.length) return ok(`Nicio locatie gasita pentru "${query}".`);
        return ok(`Locatii (${items.length}):\n${items.map(i=>`${i.type.toUpperCase()}: ${i.name}${i.region?", "+i.region:""} | ${i.country_code||"-"} | Key: ${i.key}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_custom_audiences",
    "Listeaza audientele personalizate si lookalike din cont",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(
          `/act_${acct}/customaudiences?fields=id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status&limit=50`,
          { maxItems: 200 }
        );
        if (!data.length) return ok("Nu exista audionte personalizate.");
        const lines = data.map(x => {
          const low  = x.approximate_count_lower_bound ? parseInt(x.approximate_count_lower_bound).toLocaleString() : "?";
          const high = x.approximate_count_upper_bound ? parseInt(x.approximate_count_upper_bound).toLocaleString() : "?";
          const size = low === "?" ? "in procesare" : `${low} - ${high}`;
          return `ID: ${x.id} | ${x.name} | ${x.subtype} | ~${size} persoane`;
        });
        return ok(`Audionte (${data.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_lookalike_audience",
    "Creeaza o audienta Lookalike bazata pe o audienta existenta.",
    {
      ...accountParam,
      source_audience_id: z.string().describe("ID audienta sursa din list_custom_audiences"),
      name: z.string(),
      country: z.string().default("RO").describe("Codul tarii (ex: RO, MD, US)"),
      ratio: z.number().min(0.01).max(0.20).default(0.02).describe("Procentul din populatie (0.01=1%, 0.20=20%). Mai mic = mai similar.")
    },
    async ({ ad_account_id, source_audience_id, name, country, ratio }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const d = await meta(`/act_${acct}/customaudiences`, "POST", { name, subtype: "LOOKALIKE", origin_audience_id: source_audience_id, lookalike_spec: { type: "similarity", ratio, country } });
        return ok(`Lookalike creata!\nID: ${d.id}\nNume: ${name}\nTara: ${country} | Ratio: ${(ratio*100).toFixed(0)}%`);
      } catch (e) { return err(e); }
    }
  );

  // ── LEAD FORMS ────────────────────────────────────────────────────────────
  server.tool("list_lead_forms",
    "Listeaza formularele de lead generation ale unei pagini Facebook",
    { page_id: z.string().describe("ID pagina Facebook din get_pages") },
    async ({ page_id }) => {
      try {
        const { data } = await metaPaginated(
          `/${page_id}/leadgen_forms?fields=id,name,status,leads_count,created_time&limit=25`,
          { maxItems: 100 }
        );
        if (!data.length) return ok("Nu exista formulare Lead Gen pe aceasta pagina.");
        return ok(`Formulare (${data.length}):\n${data.map(x=>`ID: ${x.id} | ${x.name} | ${x.status} | ${x.leads_count||0} leads`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_lead_submissions",
    "Descarca lead-urile dintr-un formular Lead Gen.",
    {
      form_id: z.string().describe("ID formular din list_lead_forms"),
      limit: z.number().default(50).describe("Numar maxim de lead-uri (max 500 via paginare)")
    },
    async ({ form_id, limit }) => {
      try {
        const { data } = await metaPaginated(
          `/${form_id}/leads?fields=id,created_time,field_data&limit=100`,
          { maxItems: Math.min(limit, 500) }
        );
        if (!data.length) return ok("Niciun lead gasit.");
        return ok(`Lead-uri (${data.length}):\n${data.map(l=>{
          const date = new Date(l.created_time).toLocaleString("ro-RO");
          const fields = (l.field_data||[]).map(f=>`${f.name}: ${(f.values||[]).join(", ")}`).join(" | ");
          return `${date} | ${fields}`;
        }).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── PLASAMENTE & REACH ───────────────────────────────────────────────────
  server.tool("get_reach_estimate",
    "Estimeaza reach-ul si CPM inainte de a crea campania. Verifica daca audienta e prea mica sau prea mare.",
    {
      ...accountParam,
      countries: z.array(z.string()).default(["RO"]).describe("Coduri ISO 2"),
      age_min: z.number().default(18),
      age_max: z.number().default(65),
      genders: z.array(z.number()).default([1,2]),
      optimization_goal: z.enum(["LEAD_GENERATION","LINK_CLICKS","IMPRESSIONS","REACH","OFFSITE_CONVERSIONS"]).default("LEAD_GENERATION"),
      interest_ids: z.array(z.string()).optional().describe("ID-uri interese din search_interests"),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD pentru estimare cost")
    },
    async ({ ad_account_id, countries, age_min, age_max, genders, optimization_goal, interest_ids, daily_budget }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const targeting = { age_min, age_max, genders, geo_locations: { countries } };
        if (interest_ids?.length) targeting.flexible_spec = [{ interests: interest_ids.map(id => ({ id })) }];
        const tsEnc = encodeURIComponent(JSON.stringify(targeting));
        let url = `/act_${acct}/reachestimate?targeting_spec=${tsEnc}&optimization_goal=${optimization_goal}&currency=USD`;
        if (daily_budget) url += `&daily_budget=${daily_budget}`;
        const d = await meta(url);
        const users = (d.users || 0).toLocaleString();
        const low   = ((d.estimate_mau_lower_bound || 0)/1e6).toFixed(1);
        const high  = ((d.estimate_mau_upper_bound || 0)/1e6).toFixed(1);
        return ok(`Estimare reach:\nUseri potentiali: ${users}\nEstimare MAU: ${low}M - ${high}M\n\nDate complete: ${JSON.stringify(d, null, 2)}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_ad_preview",
    "Previzualizeaza cum arata o reclama inainte de publicare pe diferite plasamente",
    {
      ...accountParam,
      ad_id: z.string().optional().describe("ID-ul unui Ad existent"),
      creative_id: z.string().optional().describe("ID-ul unui Creative (alternativa la ad_id)"),
      ad_format: z.enum([
        "DESKTOP_FEED_STANDARD",
        "MOBILE_FEED_STANDARD",
        "INSTAGRAM_STANDARD",
        "INSTAGRAM_STORY",
        "FACEBOOK_STORY",
        "MOBILE_BANNER",
        "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
        "INSTAGRAM_REELS"
      ]).default("MOBILE_FEED_STANDARD").describe("Formatul de preview")
    },
    async ({ ad_account_id, ad_id, creative_id, ad_format }) => {
      try {
        if (!ad_id && !creative_id) throw new Error("Specifica fie ad_id fie creative_id");
        let d;
        if (ad_id) {
          d = await meta(`/${ad_id}/previews?ad_format=${ad_format}`);
        } else {
          const acct = resolveAccount(ad_account_id);
          const creativeEnc = encodeURIComponent(JSON.stringify({ creative_id }));
          d = await meta(`/act_${acct}/generatepreviews?creative=${creativeEnc}&ad_format=${ad_format}`);
        }
        const preview = (d.data||[])[0];
        if (!preview) return ok("Niciun preview disponibil.");
        return ok(`Preview generat!\nFormat: ${ad_format}\nHTML disponibil (${(preview.body||"").length} chars)\n\nCopiaza HTML-ul in browser pentru vizualizare:\n${(preview.body||"").slice(0, 500)}...`);
      } catch (e) { return err(e); }
    }
  );

  // ── REGULI AUTOMATE ───────────────────────────────────────────────────────
  server.tool("create_rule",
    "Creeaza o regula automata Meta: pauzeaza cand CPL > prag, creste buget cand ROAS > target, etc.",
    {
      ...accountParam,
      name: z.string().describe("Numele regulii"),
      entity_type: z.enum(["CAMPAIGN","ADSET","AD"]).default("ADSET").describe("Tipul entitatii la care se aplica regula"),
      action: z.enum(["PAUSE","UNPAUSE","INCREASE_BUDGET","DECREASE_BUDGET","SEND_NOTIFICATION"]).describe("Actiunea care se executa"),
      metric: z.enum(["COST_PER_RESULT","ROAS","CTR","SPEND","IMPRESSIONS","FREQUENCY","CPM","CPC"]).describe("Metrica monitorizata"),
      operator: z.enum(["GREATER_THAN","LESS_THAN"]).describe("Operatorul de comparatie"),
      threshold: z.number().describe("Pragul declansator (ex: 5 pentru CPL > $5, 2 pentru ROAS > 2)"),
      budget_change_percent: z.number().optional().describe("Procentul cu care se modifica bugetul. Necesar pentru INCREASE_BUDGET/DECREASE_BUDGET."),
      schedule: z.enum(["DAILY","HOURLY","SEMI_HOURLY"]).default("DAILY").describe("Frecventa de evaluare a regulii"),
      time_window: z.enum(["LAST_3_DAYS","LAST_7_DAYS","LAST_14_DAYS","LAST_30_DAYS","LIFETIME"]).default("LAST_7_DAYS").describe("Fereastra de timp pentru evaluarea metricii")
    },
    async ({ ad_account_id, name, entity_type, action, metric, operator, threshold, budget_change_percent, schedule, time_window }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const metric_map = {
          COST_PER_RESULT: "cost_per_result",
          ROAS: "purchase_roas",
          CTR: "ctr",
          SPEND: "spend",
          IMPRESSIONS: "impressions",
          FREQUENCY: "frequency",
          CPM: "cpm",
          CPC: "cpc"
        };

        const time_preset_map = {
          LAST_3_DAYS: "LAST_3_DAYS",
          LAST_7_DAYS: "LAST_7_DAYS",
          LAST_14_DAYS: "LAST_14_DAYS",
          LAST_30_DAYS: "LAST_30_DAYS",
          LIFETIME: "LIFETIME"
        };

        const evaluation_spec = {
          evaluation_type: "SCHEDULE",
          filters: [{
            field: metric_map[metric],
            value: [threshold],
            operator
          }],
          time_preset: time_preset_map[time_window]
        };

        const execution_spec = { execution_type: action };
        if ((action === "INCREASE_BUDGET" || action === "DECREASE_BUDGET") && budget_change_percent) {
          execution_spec.execution_options = [{
            field: "budget",
            value: budget_change_percent,
            operator: action === "INCREASE_BUDGET" ? "PERCENTAGE_INCREASE" : "PERCENTAGE_DECREASE"
          }];
        }

        const body = {
          name,
          evaluation_spec,
          execution_spec,
          schedule_spec: { schedule_type: schedule },
          entity_type,
          status: "ENABLED"
        };

        const d = await meta(`/act_${acct}/adrules_library`, "POST", body);
        return ok(`Regula creata!\nID: ${d.id}\nNume: ${name}\nActiune: ${action} cand ${metric} ${operator.replace("_"," ")} ${threshold}\nFereastra: ${time_window}\nEvaluare: ${schedule}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_rules",
    "Listeaza regulile automate active din cont",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(
          `/act_${acct}/adrules_library?fields=id,name,status,evaluation_spec,execution_spec&limit=50`,
          { maxItems: 200 }
        );
        if (!data.length) return ok("Nu exista reguli automate.");
        return ok(`Reguli automate (${data.length}):\n${data.map(r => `ID: ${r.id} | ${r.name} | ${r.status}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("delete_rule",
    "Sterge sau dezactiveaza o regula automata",
    {
      rule_id: z.string().describe("ID-ul regulii din list_rules"),
      action: z.enum(["DELETE","PAUSE"]).default("PAUSE").describe("DELETE = sterge definitiv, PAUSE = dezactiveaza temporar")
    },
    async ({ rule_id, action }) => {
      try {
        if (action === "DELETE") {
          await meta(`/${rule_id}`, "DELETE");
          return ok(`Regula ${rule_id} stearsa definitiv.`);
        } else {
          await meta(`/${rule_id}`, "POST", { status: "DISABLED" });
          return ok(`Regula ${rule_id} dezactivata.`);
        }
      } catch (e) { return err(e); }
    }
  );

  // ── A/B TESTING ───────────────────────────────────────────────────────────
  server.tool("create_experiment",
    "Creeaza un A/B test intre doua campanii pentru a compara audienta, creative sau strategie de bidding",
    {
      ...accountParam,
      name: z.string().describe("Numele experimentului"),
      campaign_id_a: z.string().describe("ID campanie varianta A (de control)"),
      campaign_id_b: z.string().describe("ID campanie varianta B (de test)"),
      objective: z.enum(["AUCTION_BASED","REACH_BASED"]).default("AUCTION_BASED").describe("Tipul experimentului"),
      split_percent: z.number().min(10).max(50).default(50).describe("Procentul de audienta pentru varianta B (10-50%)"),
      end_time: z.string().describe("Data de sfarsit ISO 8601. Recomandat: minim 7 zile pentru semnificatie statistica.")
    },
    async ({ ad_account_id, name, campaign_id_a, campaign_id_b, objective, split_percent, end_time }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const body = {
          name,
          cells: JSON.stringify([
            { campaign_ids: [campaign_id_a], split_percentage: 100 - split_percent },
            { campaign_ids: [campaign_id_b], split_percentage: split_percent }
          ]),
          objective,
          end_time
        };
        const d = await meta(`/act_${acct}/adstudies`, "POST", body);
        return ok(`Experiment A/B creat!\nID: ${d.id}\nNume: ${name}\nSplit: ${100-split_percent}% varianta A / ${split_percent}% varianta B\nSfarsit: ${end_time}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_experiment_results",
    "Vede rezultatele unui A/B test cu semnificatie statistica",
    { experiment_id: z.string().describe("ID-ul experimentului din create_experiment") },
    async ({ experiment_id }) => {
      try {
        const d = await meta(`/${experiment_id}?fields=id,name,description,status,cells,start_time,end_time,results`);
        return json(d);
      } catch (e) { return err(e); }
    }
  );

  // ── CONVERSII & CALITATE ──────────────────────────────────────────────────
  server.tool("list_custom_conversions",
    "Listeaza evenimentele de conversie din pixel. Necesar pentru a seta obiective specifice per campanie.",
    { ...accountParam },
    async ({ ad_account_id }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const { data } = await metaPaginated(
          `/act_${acct}/customconversions?fields=id,name,event_source_type,custom_event_type,rule,pixel&limit=50`,
          { maxItems: 200 }
        );
        if (!data.length) return ok("Nu exista custom conversions. Creeaza-le in Meta Events Manager.");
        return ok(`Custom Conversions (${data.length}):\n${data.map(c => `ID: ${c.id} | ${c.name} | ${c.custom_event_type || c.event_source_type}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── BULK OPERATIONS ───────────────────────────────────────────────────────
  server.tool("bulk_update_campaigns",
    "Modifica status sau buget la mai multe campanii simultan",
    {
      campaign_ids: z.array(z.string()).min(1).max(50).describe("Lista de ID-uri campanii (max 50)"),
      status: z.enum(["ACTIVE","PAUSED"]).optional().describe("Noul status pentru toate campaniile"),
      daily_budget: z.number().optional().describe("Noul buget zilnic in CENTI USD pentru toate campaniile")
    },
    async ({ campaign_ids, status, daily_budget }) => {
      try {
        if (!status && !daily_budget) throw new Error("Specifica cel putin status sau daily_budget.");
        const results = { success: [], failed: [] };
        for (const id of campaign_ids) {
          try {
            const body = {};
            if (status)       body.status = status;
            if (daily_budget) body.daily_budget = daily_budget;
            await meta(`/${id}`, "POST", body);
            results.success.push(id);
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            results.failed.push(`${id}: ${e.message}`);
          }
        }
        return ok(`Bulk update finalizat:\n✓ Succes: ${results.success.length}/${campaign_ids.length}\n${results.failed.length ? "✗ Erori:\n" + results.failed.join("\n") : ""}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("bulk_update_adsets",
    "Modifica status sau buget la mai multe ad set-uri simultan",
    {
      adset_ids: z.array(z.string()).min(1).max(50).describe("Lista de ID-uri ad set-uri (max 50)"),
      status: z.enum(["ACTIVE","PAUSED"]).optional(),
      daily_budget: z.number().optional().describe("Noul buget zilnic in CENTI USD")
    },
    async ({ adset_ids, status, daily_budget }) => {
      try {
        if (!status && !daily_budget) throw new Error("Specifica cel putin status sau daily_budget.");
        const results = { success: [], failed: [] };
        for (const id of adset_ids) {
          try {
            const body = {};
            if (status)       body.status = status;
            if (daily_budget) body.daily_budget = daily_budget;
            await meta(`/${id}`, "POST", body);
            results.success.push(id);
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            results.failed.push(`${id}: ${e.message}`);
          }
        }
        return ok(`Bulk update ad sets:\n✓ Succes: ${results.success.length}/${adset_ids.length}\n${results.failed.length ? "✗ Erori:\n" + results.failed.join("\n") : ""}`);
      } catch (e) { return err(e); }
    }
  );

  // ── AUDIENTA RETARGETING ─────────────────────────────────────────────────
  server.tool("create_website_audience",
    "Creeaza audienta din vizitatori website (pixel-based). Tipul cel mai eficient de retargeting.",
    {
      ...accountParam,
      name: z.string().describe("Numele audientei (ex: 'Vizitatori site 30 zile')"),
      pixel_id: z.string().describe("ID-ul pixelului Meta din list_pixels"),
      retention_days: z.number().min(1).max(180).default(30).describe("Perioada de retentie in zile (1-180)."),
      event_name: z.enum(["PageView","ViewContent","AddToCart","InitiateCheckout","Purchase","Lead","CompleteRegistration","Search","Contact","SubmitApplication"]).default("PageView").describe("Evenimentul pixel pe care se bazeaza audienta."),
      url_filter: z.string().optional().describe("Filtreaza dupa URL specific. Lasa gol pentru tot site-ul."),
      description: z.string().optional()
    },
    async ({ ad_account_id, name, pixel_id, retention_days, event_name, url_filter, description }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const rule = {
          inclusions: {
            operator: "or",
            rules: [{
              event_sources: [{ id: pixel_id, type: "pixel" }],
              retention_seconds: retention_days * 86400,
              filter: {
                operator: "and",
                filters: [
                  { field: "event", operator: "eq", value: event_name },
                  ...(url_filter ? [{ field: "url", operator: "contains", value: url_filter }] : [])
                ]
              }
            }]
          }
        };

        const body = {
          name,
          subtype: "WEBSITE",
          description: description || `${event_name} - ultimele ${retention_days} zile`,
          customer_file_source: "USER_PROVIDED_ONLY",
          rule: JSON.stringify(rule)
        };

        const d = await meta(`/act_${acct}/customaudiences`, "POST", body);
        return ok(`Audienta website creata!\nID: ${d.id}\nNume: ${name}\nEveniment: ${event_name}\nRetentie: ${retention_days} zile\n${url_filter ? "Filtru URL: " + url_filter + "\n" : ""}\nFoloseste ID-ul ${d.id} in create_adset pentru retargeting.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_engagement_audience",
    "Creeaza audienta din persoanele care au interactionat cu pagina Facebook sau contul Instagram.",
    {
      ...accountParam,
      name: z.string().describe("Numele audientei"),
      source_type: z.enum(["FACEBOOK_PAGE","INSTAGRAM_ACCOUNT","VIDEO","LEAD_FORM","EVENT"]).describe("Sursa de engagement"),
      source_id: z.string().describe("ID-ul sursei"),
      retention_days: z.number().min(1).max(365).default(30).describe("Perioada de retentie in zile (max 365)."),
      engagement_type: z.enum(["PAGE_ENGAGED_USERS","PAGE_VISITORS","PAGE_SAVED","PAGE_POST_INTERACTIONS","PAGE_AD_CLICKERS","INSTAGRAM_BUSINESS_PROFILE_ALL","INSTAGRAM_BUSINESS_PROFILE_ENGAGED","WATCH_85_PERCENT","WATCH_50_PERCENT","WATCH_25_PERCENT","OPENED_FORM","COMPLETED_FORM"]).describe("Tipul de interactiune")
    },
    async ({ ad_account_id, name, source_type, source_id, retention_days, engagement_type }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const subtype_map = {
          FACEBOOK_PAGE:    "PAGE",
          INSTAGRAM_ACCOUNT:"INSTAGRAM_BUSINESS",
          VIDEO:            "VIDEO",
          LEAD_FORM:        "LEAD_GENERATION",
          EVENT:            "EVENT"
        };

        const body = {
          name,
          subtype: subtype_map[source_type],
          description: `Engagement ${source_type} - ultimele ${retention_days} zile`,
          retention_days,
          rule: JSON.stringify({
            inclusions: {
              operator: "or",
              rules: [{
                event_sources: [{ id: source_id, type: source_type.toLowerCase() }],
                retention_seconds: retention_days * 86400,
                filter: {
                  operator: "and",
                  filters: [{ field: "event", operator: "eq", value: engagement_type }]
                }
              }]
            }
          })
        };

        const d = await meta(`/act_${acct}/customaudiences`, "POST", body);
        return ok(`Audienta engagement creata!\nID: ${d.id}\nNume: ${name}\nSursa: ${source_type} (${source_id})\nTip engagement: ${engagement_type}\nRetentie: ${retention_days} zile\n\nFoloseste ID-ul ${d.id} in create_adset pentru retargeting.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_customer_list_audience",
    "Creeaza audienta din lista de clienti (emailuri sau numere de telefon). Meta le hashuieste automat si cauta matching.",
    {
      ...accountParam,
      name: z.string().describe("Numele audientei"),
      data_type: z.enum(["EMAIL","PHONE"]).describe("Tipul datelor"),
      values: z.array(z.string()).min(1).max(1000).describe("Lista de emailuri sau telefoane. Max 1000 per request."),
      description: z.string().optional()
    },
    async ({ ad_account_id, name, data_type, values, description }) => {
      try {
        const acct = resolveAccount(ad_account_id);
        const audience = await meta(`/act_${acct}/customaudiences`, "POST", {
          name,
          subtype: "CUSTOM",
          description: description || `Lista ${data_type.toLowerCase()} - ${values.length} intrari`,
          customer_file_source: "USER_PROVIDED_ONLY"
        });

        const crypto = await import("crypto");
        const normalize = (val, type) => {
          if (type === "EMAIL") return val.toLowerCase().trim();
          if (type === "PHONE") return val.replace(/\D/g, "");
          return val;
        };
        const hashed = values.map(v => crypto.createHash("sha256").update(normalize(v, data_type)).digest("hex"));

        await meta(`/${audience.id}/users`, "POST", {
          payload: {
            schema: [data_type],
            data: hashed.map(h => [h])
          }
        });

        return ok(`Audienta lista clienti creata!\nID: ${audience.id}\nNume: ${name}\nTip: ${data_type}\nIntrari uploadate: ${values.length}\n\nMeta va procesa lista si va gasi matching in 24-48 ore.\nFoloseste ID-ul ${audience.id} in create_adset pentru retargeting.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_audience_details",
    "Vede detalii despre o audienta: marimea, statusul de livrare si tipul.",
    { audience_id: z.string().describe("ID-ul audientei din list_custom_audiences") },
    async ({ audience_id }) => {
      try {
        const fields = "id,name,subtype,approximate_count,delivery_status,data_source,retention_days,rule,description,time_created,time_updated";
        const d = await meta(`/${audience_id}?fields=${fields}`);
        const status = d.delivery_status?.description || d.delivery_status?.code || "necunoscut";
        const count  = d.approximate_count ? parseInt(d.approximate_count).toLocaleString() : "in procesare";
        return ok(`Audienta: ${d.name}\nID: ${d.id}\nTip: ${d.subtype}\nMarime estimata: ~${count} persoane\nStatus livrare: ${status}\nRetentie: ${d.retention_days || "-"} zile\nCreata: ${d.time_created ? new Date(d.time_created * 1000).toLocaleDateString("ro-RO") : "-"}\nActualizata: ${d.time_updated ? new Date(d.time_updated * 1000).toLocaleDateString("ro-RO") : "-"}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("delete_audience",
    "Sterge o audienta custom. Atentie: actiunea este ireversibila.",
    { audience_id: z.string().describe("ID-ul audientei de sters") },
    async ({ audience_id }) => {
      try {
        await meta(`/${audience_id}`, "DELETE");
        return ok(`Audienta ${audience_id} stearsa definitiv.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("add_users_to_audience",
    "Adauga utilizatori intr-o audienta existenta (emailuri sau telefoane).",
    {
      audience_id: z.string().describe("ID-ul audientei din list_custom_audiences"),
      data_type: z.enum(["EMAIL","PHONE"]).describe("Tipul datelor"),
      values: z.array(z.string()).min(1).max(1000).describe("Lista de emailuri sau telefoane de adaugat")
    },
    async ({ audience_id, data_type, values }) => {
      try {
        const crypto = await import("crypto");
        const normalize = (val, type) => {
          if (type === "EMAIL") return val.toLowerCase().trim();
          if (type === "PHONE") return val.replace(/\D/g, "");
          return val;
        };
        const hashed = values.map(v => crypto.createHash("sha256").update(normalize(v, data_type)).digest("hex"));

        await meta(`/${audience_id}/users`, "POST", {
          payload: { schema: [data_type], data: hashed.map(h => [h]) }
        });

        return ok(`${values.length} utilizatori adaugati in audienta ${audience_id}.\nMeta va procesa in 24-48 ore.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("remove_users_from_audience",
    "Elimina utilizatori dintr-o audienta (emailuri sau telefoane).",
    {
      audience_id: z.string().describe("ID-ul audientei"),
      data_type: z.enum(["EMAIL","PHONE"]).describe("Tipul datelor"),
      values: z.array(z.string()).min(1).max(1000).describe("Lista de emailuri sau telefoane de eliminat")
    },
    async ({ audience_id, data_type, values }) => {
      try {
        const crypto = await import("crypto");
        const normalize = (val, type) => {
          if (type === "EMAIL") return val.toLowerCase().trim();
          if (type === "PHONE") return val.replace(/\D/g, "");
          return val;
        };
        const hashed = values.map(v => crypto.createHash("sha256").update(normalize(v, data_type)).digest("hex"));

        await meta(`/${audience_id}/users`, "DELETE", {
          payload: { schema: [data_type], data: hashed.map(h => [h]) }
        });

        return ok(`${values.length} utilizatori eliminati din audienta ${audience_id}.`);
      } catch (e) { return err(e); }
    }
  );

  return server;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// Middleware de autentificare — accepta secret prin:
//   1. Query parameter: ?key=SECRET (compatibil cu Claude.ai custom connectors)
//   2. Authorization: Bearer SECRET header (pentru clienti care suporta custom headers)
// Timing-safe comparison ca sa previna timing attacks
function authMiddleware(req, res, next) {
  const queryKey  = req.query.key || "";
  const headerKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const provided  = queryKey || headerKey;

  if (!provided) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: lipsa parametru 'key' in query sau header 'Authorization: Bearer'" },
      id: null
    });
  }

  // Timing-safe comparison
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_SECRET);
  const valid = a.length === b.length && timingSafeEqual(a, b);

  if (!valid) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: secret invalid" },
      id: null
    });
  }
  next();
}

app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => server.close().catch(() => {}));
  } catch (e) {
    console.error("MCP error:", e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
  }
});

app.get("/mcp", (_, res) => res.status(405).send("POST /mcp only"));

// Health check public — util pentru Railway uptime monitoring
// NU expune niciodata TOKEN sau MCP_SECRET, doar flag-uri boolean de prezenta
app.get("/health", (_, res) => res.json({
  status: "ok",
  server: "meta-ads-mcp",
  version: "4.1.0",
  token_configured: !!TOKEN,
  secret_configured: !!MCP_SECRET,
  default_account: DEFAULT_ACCT ? `act_${normalizeAccountId(DEFAULT_ACCT)}` : "NOT SET (multi-account mode)",
  api: API
}));

app.listen(PORT, () => {
  console.log(`✓ Meta Ads MCP Server v4.1.0 running on port ${PORT}`);
  console.log(`✓ Token: configured`);
  console.log(`✓ MCP secret: configured (auth via ?key= query param sau Bearer header)`);
  console.log(DEFAULT_ACCT
    ? `✓ Default account: act_${normalizeAccountId(DEFAULT_ACCT)} (override cu ad_account_id per call)`
    : `ℹ Multi-account mode: fiecare tool call necesita ad_account_id explicit`
  );
});
