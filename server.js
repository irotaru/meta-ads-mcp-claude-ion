/**
 * Meta Ads MCP Server v2.1 - Productie
 * 31 tools: analiza, creare campanii, creative (imagine/video/carousel),
 * audienta, lead forms, management complet
 *
 * Compatibil cu Claude.ai custom connectors (Streamable HTTP transport)
 * Meta Graph API v20.0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// ─── Configuratie ─────────────────────────────────────────────────────────────
const TOKEN   = process.env.META_ADS_ACCESS_TOKEN;
const ACCOUNT = process.env.META_AD_ACCOUNT_ID;  // fara prefix "act_"
const API     = "https://graph.facebook.com/v20.0";
const PORT    = process.env.PORT || 3000;

// ─── Client Meta API ──────────────────────────────────────────────────────────
async function meta(path, method = "GET", body = null) {
  if (!TOKEN)   throw new Error("META_ADS_ACCESS_TOKEN nu este configurat in Railway Variables.");
  if (!ACCOUNT && !path.startsWith("/me") && !path.match(/^\/\d{10,}/)) {
    throw new Error("META_AD_ACCOUNT_ID nu este configurat in Railway Variables.");
  }

  const baseUrl = path.startsWith("http") ? path : `${API}${path}`;
  const sep     = baseUrl.includes("?") ? "&" : "?";
  const fullUrl = `${baseUrl}${sep}access_token=${TOKEN}`;

  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(fullUrl, opts);
  } catch (e) {
    throw new Error(`Eroare de retea: ${e.message}`);
  }

  const data = await res.json();
  if (data.error) {
    const msg = data.error.error_user_msg || data.error.message;
    throw new Error(`Meta API [${data.error.code}]: ${msg}`);
  }
  return data;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ok  = (text) => ({ content: [{ type: "text", text: String(text) }] });
const err = (e)    => ({ content: [{ type: "text", text: `Eroare: ${e.message}` }], isError: true });
const json = (obj) => ok(JSON.stringify(obj, null, 2));

// ─── Server factory (stateless — o instanta per request) ──────────────────────
function createServer() {
  const server = new McpServer({ name: "meta-ads-mcp", version: "2.1.0" });

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 1 — INFORMATII CONT
  // ═══════════════════════════════════════════════════════════════════

  server.tool("get_account_info",
    "Informatii cont publicitar: status, valuta, fus orar, cheltuieli, business manager",
    {},
    async () => {
      try {
        const f = "id,name,account_status,currency,timezone_name,spend_cap,amount_spent,business,disable_reason";
        const d = await meta(`/act_${ACCOUNT}?fields=${f}`);
        const statuses = { 1:"ACTIV", 2:"DEZACTIVAT", 3:"NEPLATIT", 7:"POLITICI INCALCATE", 9:"INCHIS", 100:"SUSPENDAT" };
        return ok([
          `Cont: ${d.name} (ID: ${d.id})`,
          `Status: ${statuses[d.account_status] || d.account_status}`,
          `Valuta: ${d.currency} | Fus orar: ${d.timezone_name}`,
          `Cheltuit total: ${((d.amount_spent || 0) / 100).toFixed(2)} ${d.currency}`,
          d.spend_cap ? `Limita cheltuieli: ${(d.spend_cap / 100).toFixed(2)} ${d.currency}` : "",
          d.business ? `Business Manager: ${d.business.name} (ID: ${d.business.id})` : "Fara Business Manager asociat",
        ].filter(Boolean).join("\n"));
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_pages",
    "Listeaza paginile Facebook ale contului. Necesar pentru create_creative (furnizeaza page_id).",
    {},
    async () => {
      try {
        let pages = [];
        // Incearca token de user standard
        try {
          const d = await meta(`/me/accounts?fields=id,name,category,fan_count&limit=50`);
          pages = d.data || [];
        } catch {
          // Fallback: Business Manager pages
          const biz = await meta(`/act_${ACCOUNT}?fields=business`);
          if (biz.business) {
            const d = await meta(`/${biz.business.id}/owned_pages?fields=id,name,category,fan_count&limit=50`);
            pages = d.data || [];
          }
        }
        if (!pages.length) return ok("Nicio pagina Facebook gasita.\nVerifica: pagina trebuie conectata la Business Manager si System User-ul trebuie sa aiba acces la ea.");
        const lines = pages.map(p => `ID: ${p.id} | ${p.name} | ${p.category} | ${(p.fan_count || 0).toLocaleString()} urmaritori`);
        return ok(`Pagini Facebook (${pages.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_pixels",
    "Listeaza pixelii Meta din cont. Necesar pentru campanii cu obiectiv OFFSITE_CONVERSIONS.",
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adspixels?fields=id,name,last_fired_time&limit=25`);
        const pixels = d.data || [];
        if (!pixels.length) return ok("Niciun pixel Meta gasit. Creeaza unul in Meta Events Manager.");
        const lines = pixels.map(p => {
          const last = p.last_fired_time ? new Date(p.last_fired_time * 1000).toLocaleDateString("ro-RO") : "Niciodata";
          return `ID: ${p.id} | ${p.name} | Ultimul foc: ${last}`;
        });
        return ok(`Pixeli Meta (${pixels.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_instagram_accounts",
    "Listeaza conturile Instagram conectate. Necesar pentru create_creative cu plasament Instagram.",
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}/instagram_accounts?fields=id,username&limit=25`);
        const accounts = d.data || [];
        if (!accounts.length) return ok("Niciun cont Instagram conectat. Conecteaza contul in Business Manager > Instagram Accounts.");
        return ok(`Conturi Instagram (${accounts.length}):\n${accounts.map(a => `ID: ${a.id} | @${a.username}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 2 — CITIRE CAMPANII
  // ═══════════════════════════════════════════════════════════════════

  server.tool("list_campaigns",
    "Listeaza campaniile din cont cu status, obiectiv si buget",
    { status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL") },
    async ({ status }) => {
      try {
        const filter = status === "ALL" ? "" : `&effective_status=["${status}"]`;
        const fields = "id,name,status,objective,daily_budget,lifetime_budget,created_time";
        const d = await meta(`/act_${ACCOUNT}/campaigns?fields=${fields}${filter}&limit=100`);
        const camps = d.data || [];
        if (!camps.length) return ok("Nu exista campanii.");
        const lines = camps.map(c => {
          const budget = c.daily_budget
            ? `${(c.daily_budget / 100).toFixed(2)}$/zi`
            : c.lifetime_budget ? `${(c.lifetime_budget / 100).toFixed(2)}$ total` : "-";
          return `ID: ${c.id} | ${c.name} | ${c.status} | ${c.objective} | ${budget}`;
        });
        return ok(`Campanii (${camps.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_adsets",
    "Listeaza Ad Set-urile dintr-o campanie cu buget, targeting si status",
    { campaign_id: z.string().describe("ID-ul campaniei") },
    async ({ campaign_id }) => {
      try {
        const fields = "id,name,status,daily_budget,lifetime_budget,targeting,optimization_goal,start_time,end_time";
        const d = await meta(`/${campaign_id}/adsets?fields=${fields}&limit=100`);
        return json(d.data || []);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_ads",
    "Listeaza Ad-urile dintr-un Ad Set cu status si creative",
    { adset_id: z.string().describe("ID-ul Ad Set-ului") },
    async ({ adset_id }) => {
      try {
        const fields = "id,name,status,creative{id,name}";
        const d = await meta(`/${adset_id}/ads?fields=${fields}&limit=100`);
        return json(d.data || []);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_images",
    "Listeaza imaginile uploadate in cont. Foloseste hash-ul pentru a reutiliza creative existente fara re-upload.",
    { limit: z.number().default(25).describe("Numar maxim de imagini") },
    async ({ limit }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adimages?fields=hash,name,url,width,height,status&limit=${limit}`);
        const images = d.data || [];
        if (!images.length) return ok("Nu exista imagini uploadate in cont.");
        const lines = images.map(i => `Hash: ${i.hash} | ${i.name || "fara_nume"} | ${i.width}x${i.height}px | ${i.status}`);
        return ok(`Imagini existente (${images.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 3 — INSIGHTS & ANALIZA
  // ═══════════════════════════════════════════════════════════════════

  server.tool("get_all_insights",
    "Raport complet CPL/ROAS pentru toate campaniile. Foloseste pentru monitorizare zilnica.",
    {
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      level: z.enum(["campaign","adset","ad"]).default("campaign")
    },
    async ({ date_preset, level }) => {
      try {
        const fields = [
          "campaign_name","campaign_id","adset_name","adset_id",
          "ad_name","ad_id","spend","impressions","clicks","reach",
          "frequency","ctr","cpc","actions","cost_per_action_type"
        ].join(",");
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=${level}&limit=200`);
        const rows = d.data || [];
        if (!rows.length) return ok("Nu exista date pentru perioada selectata.");
        return json(rows);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_insights",
    "Analiza detaliata pentru o campanie, ad set sau ad individual. Suporta segmentare pe varsta, gen, plasament.",
    {
      object_id: z.string().describe("ID campanie, ad set sau ad"),
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      breakdown: z.enum(["none","age","gender","country","placement","device_platform"]).default("none")
    },
    async ({ object_id, date_preset, breakdown }) => {
      try {
        const fields = "spend,impressions,clicks,reach,frequency,ctr,cpc,actions,cost_per_action_type,unique_clicks";
        let url = `/${object_id}/insights?fields=${fields}&date_preset=${date_preset}`;
        if (breakdown !== "none") url += `&breakdowns=${breakdown}`;
        const d = await meta(url);
        return json(d.data || d);
      } catch (e) { return err(e); }
    }
  );

  server.tool("analyze_wasted_spend",
    "Identifica campaniile si ad set-urile care cheltuiesc fara conversii. Esential pentru optimizarea CPL.",
    {
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_7d"),
      cpl_threshold: z.number().default(3).describe("Prag CPL in dolari - ad set-urile peste acest prag sunt ineficiente")
    },
    async ({ date_preset, cpl_threshold }) => {
      try {
        const fields = "campaign_name,campaign_id,adset_name,adset_id,spend,actions,cost_per_action_type,impressions,clicks";
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=adset&limit=200`);
        const rows = d.data || [];

        const wasted = [], efficient = [];
        for (const row of rows) {
          const spend = parseFloat(row.spend || 0);
          const leads = parseInt((row.actions || []).find(a => ["lead","onsite_conversion.lead_grouped","leadgen.other"].includes(a.action_type))?.value || 0);
          const cpl = leads > 0 ? spend / leads : null;
          const item = {
            campanie: row.campaign_name,
            adset: row.adset_name,
            spend: `$${spend.toFixed(2)}`,
            leads,
            cpl: cpl ? `$${cpl.toFixed(2)}` : "0 leads"
          };
          (cpl === null || cpl > cpl_threshold ? wasted : efficient).push(item);
        }

        const wastedTotal = wasted.reduce((s, r) => s + parseFloat(r.spend.slice(1)), 0);
        let out = `=== ANALIZA CHELTUIELI (prag CPL: $${cpl_threshold}, ${date_preset}) ===\n\n`;
        out += `Cheltuieli ineficiente: $${wastedTotal.toFixed(2)}\n\n`;
        out += `AD SETS INEFICIENTE (${wasted.length}):\n`;
        wasted.sort((a,b) => parseFloat(b.spend.slice(1)) - parseFloat(a.spend.slice(1)));
        wasted.forEach(r => out += `  ✕ ${r.adset} | ${r.spend} | ${r.leads} leads | CPL: ${r.cpl}\n`);
        out += `\nAD SETS EFICIENTE (${efficient.length}):\n`;
        efficient.forEach(r => out += `  ✓ ${r.adset} | ${r.spend} | ${r.leads} leads | CPL: ${r.cpl}\n`);
        return ok(out);
      } catch (e) { return err(e); }
    }
  );

  server.tool("detect_creative_fatigue",
    "Detecteaza reclame cu frecventa ridicata si CTR in scadere. Semnal ca trebuie schimbat creativul.",
    {
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_14d"),
      frequency_threshold: z.number().default(2.5).describe("Frecventa medie peste care un creativ e considerat obosit (2.5 = standard)")
    },
    async ({ date_preset, frequency_threshold }) => {
      try {
        const fields = "ad_name,ad_id,campaign_name,adset_name,spend,impressions,frequency,ctr,reach";
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=ad&limit=200`);
        const rows = d.data || [];

        const fatigued = rows.filter(r => parseFloat(r.frequency || 0) >= frequency_threshold)
          .sort((a,b) => parseFloat(b.frequency) - parseFloat(a.frequency));
        const ok_ads = rows.filter(r => parseFloat(r.frequency || 0) < frequency_threshold);

        let out = `=== DETECTIE FATIGUE CREATIVE (${date_preset}, prag: ${frequency_threshold}) ===\n\n`;
        out += `RECLAME OBOSITE - necesita refresh (${fatigued.length}):\n`;
        fatigued.forEach(r => {
          out += `  ! ${r.ad_name}\n`;
          out += `    Campanie: ${r.campaign_name} | Frecventa: ${parseFloat(r.frequency).toFixed(1)} | CTR: ${parseFloat(r.ctr||0).toFixed(2)}% | Reach: ${parseInt(r.reach||0).toLocaleString()}\n\n`;
        });
        out += `\nRECLAME OK (${ok_ads.length}) - frecventa sub prag\n`;
        return ok(out);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 4 — CREARE CAMPANIE (flux complet)
  // ═══════════════════════════════════════════════════════════════════

  server.tool("create_campaign",
    "Pas 1/5: Creeaza o campanie noua. Returneaza campaign_id pentru create_adset.",
    {
      name: z.string().describe("Numele campaniei"),
      objective: z.enum([
        "OUTCOME_LEADS","OUTCOME_SALES","OUTCOME_TRAFFIC",
        "OUTCOME_AWARENESS","OUTCOME_ENGAGEMENT","OUTCOME_APP_PROMOTION"
      ]).describe("Obiectivul campaniei"),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD (1000=$10). Nu combina cu lifetime_budget."),
      lifetime_budget: z.number().optional().describe("Buget total in CENTI USD. Necesita stop_time. Nu combina cu daily_budget."),
      stop_time: z.string().optional().describe("Data sfarsit ISO 8601 (ex: 2024-12-31T23:59:59+0000). Necesar cu lifetime_budget."),
      special_ad_categories: z.array(z.string()).default([]).describe("Categorii speciale: CREDIT, EMPLOYMENT, HOUSING, ISSUES_ELECTIONS_POLITICS. Lasa gol in mod normal.")
    },
    async ({ name, objective, daily_budget, lifetime_budget, stop_time, special_ad_categories }) => {
      try {
        if (daily_budget && lifetime_budget) throw new Error("Foloseste fie daily_budget fie lifetime_budget, nu ambele.");
        if (lifetime_budget && !stop_time)   throw new Error("lifetime_budget necesita stop_time.");

        const body = { name, objective, status: "PAUSED", special_ad_categories };
        if (daily_budget)    body.daily_budget = daily_budget;
        if (lifetime_budget) body.lifetime_budget = lifetime_budget;
        if (stop_time)       body.stop_time = stop_time;

        const d = await meta(`/act_${ACCOUNT}/campaigns`, "POST", body);
        return ok(`✓ Campanie creata!\nID: ${d.id}\nNume: ${name}\nObiectiv: ${objective}\nStatus: PAUSED\n\nPasul urmator → create_adset cu campaign_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_adset",
    "Pas 2/5: Creeaza un Ad Set cu targeting. Returneaza adset_id pentru create_ad.",
    {
      campaign_id: z.string().describe("ID campanie din create_campaign"),
      name: z.string().describe("Numele Ad Set-ului"),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD. Optional daca campania are buget propriu."),
      age_min: z.number().default(18).describe("Varsta minima 18-65"),
      age_max: z.number().default(65).describe("Varsta maxima 18-65"),
      genders: z.array(z.number()).default([1,2]).describe("1=Barbati 2=Femei [1,2]=Ambele"),
      countries: z.array(z.string()).default(["RO"]).describe("Coduri ISO 2 (ex: ['RO','MD'])"),
      optimization_goal: z.enum([
        "LEAD_GENERATION","LINK_CLICKS","IMPRESSIONS","REACH",
        "OFFSITE_CONVERSIONS","LANDING_PAGE_VIEWS","THRUPLAY"
      ]).default("LEAD_GENERATION"),
      billing_event: z.enum(["IMPRESSIONS","LINK_CLICKS","THRUPLAY"]).default("IMPRESSIONS"),
      bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP","LOWEST_COST_WITH_BID_CAP","COST_CAP"]).default("LOWEST_COST_WITHOUT_CAP"),
      bid_amount: z.number().optional().describe("Bid in CENTI USD. Necesar pentru LOWEST_COST_WITH_BID_CAP si COST_CAP."),
      interest_ids: z.array(z.string()).optional().describe("ID-uri interese din search_interests (ex: ['6003107902433','6003349442621'])"),
      pixel_id: z.string().optional().describe("ID pixel din list_pixels. Necesar pentru OFFSITE_CONVERSIONS."),
      end_time: z.string().optional().describe("Data sfarsit ISO 8601"),
      advantage_audience: z.number().int().min(0).max(1).default(1).describe("Advantage Audience (obligatoriu din 2024): 1=activat (recomandat), 0=dezactivat")
    },
    async ({ campaign_id, name, daily_budget, age_min, age_max, genders, countries,
             optimization_goal, billing_event, bid_strategy, bid_amount, interest_ids, pixel_id, end_time, advantage_audience }) => {
      try {
        const targeting = { age_min, age_max, genders, geo_locations: { countries } };
        if (interest_ids?.length) {
          targeting.flexible_spec = [{ interests: interest_ids.map(id => ({ id })) }];
        }

        const body = {
          campaign_id, name, targeting, optimization_goal, billing_event, bid_strategy,
          status: "PAUSED",
          advantage_audience
        };
        if (daily_budget) body.daily_budget = daily_budget;
        if (bid_amount)   body.bid_amount = bid_amount;
        if (end_time)     body.end_time = end_time;
        if (pixel_id && optimization_goal === "OFFSITE_CONVERSIONS") {
          body.promoted_object = { pixel_id, custom_event_type: "LEAD" };
        }

        const d = await meta(`/act_${ACCOUNT}/adsets`, "POST", body);
        const budgetStr = daily_budget ? `${(daily_budget/100).toFixed(2)}$/zi` : "din campanie";
        return ok(`✓ Ad Set creat!\nID: ${d.id}\nNume: ${name}\nBuget: ${budgetStr}\nStatus: PAUSED\n\nPasul urmator → upload_image sau create_creative cu adset_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_image",
    "Pas 3a/5: Uploadeaza o imagine din URL. Returneaza image_hash pentru create_creative.\n\nPentru Google Drive: Share > Anyone with link, apoi URL: https://drive.google.com/uc?export=download&id=FILE_ID",
    { image_url: z.string().url().describe("URL public direct al imaginii. Nu functioneaza cu pagini HTML, trebuie URL direct catre fisier.") },
    async ({ image_url }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adimages`, "POST", { url: image_url });
        const images = d.images || {};
        const img = Object.values(images)[0];
        if (!img) throw new Error("Upload esuat. Verifica ca URL-ul returneaza direct imaginea (nu o pagina HTML) si e accesibil public.");
        return ok(`✓ Imagine uploadata!\nHash: ${img.hash}\nDimensiune: ${img.width}x${img.height}px\n\nPasul urmator → create_creative cu image_hash="${img.hash}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_video",
    "Pas 3b/5 (video): Uploadeaza un video din URL. Returneaza video_id pentru create_video_creative.",
    {
      video_url: z.string().url().describe("URL public direct al fisierului video (MP4, max 4GB, min 1 secunda)"),
      title: z.string().default("Video Ad").describe("Titlul intern al videoclipului")
    },
    async ({ video_url, title }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/advideos`, "POST", { file_url: video_url, title });
        return ok(`✓ Video uploadat!\nID: ${d.id}\nTitlu: ${title}\n\nPasul urmator → create_video_creative cu video_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_creative",
    "Pas 4a/5: Creeaza creative cu imagine. Returneaza creative_id pentru create_ad.",
    {
      name: z.string().describe("Numele intern al creative-ului"),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      image_hash: z.string().describe("Hash imagine din upload_image sau list_images"),
      message: z.string().max(500).describe("Textul principal (suporta emoji si \\n pentru randuri noi)"),
      headline: z.string().max(40).describe("Titlul reclamei (max 40 caractere)"),
      description: z.string().max(30).optional().describe("Descriere scurta sub titlu (max 30 caractere)"),
      link_url: z.string().url().describe("URL-ul landing page-ului"),
      cta_type: z.enum([
        "LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","GET_QUOTE",
        "APPLY_NOW","DOWNLOAD","SUBSCRIBE","GET_OFFER","WATCH_MORE"
      ]).default("LEARN_MORE"),
      instagram_actor_id: z.string().optional().describe("ID cont Instagram din list_instagram_accounts. Optional, pentru plasament pe Instagram.")
    },
    async ({ name, page_id, image_hash, message, headline, description, link_url, cta_type, instagram_actor_id }) => {
      try {
        const link_data = {
          image_hash, link: link_url, message, name: headline,
          description: description || "",
          call_to_action: { type: cta_type, value: { link: link_url } }
        };
        const object_story_spec = { page_id, link_data };
        if (instagram_actor_id) object_story_spec.instagram_actor_id = instagram_actor_id;

        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", { name, object_story_spec });
        return ok(`✓ Creative creat!\nID: ${d.id}\nNume: ${name}\n\nPasul urmator → create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_video_creative",
    "Pas 4b/5: Creeaza creative cu video. Returneaza creative_id pentru create_ad.",
    {
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      video_id: z.string().describe("ID video din upload_video"),
      message: z.string().max(500).describe("Textul principal al reclamei"),
      headline: z.string().max(40).describe("Titlul reclamei"),
      link_url: z.string().url().describe("URL landing page"),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","WATCH_MORE","DOWNLOAD"]).default("LEARN_MORE"),
      thumbnail_url: z.string().url().optional().describe("URL imagine thumbnail pentru video (optional)")
    },
    async ({ name, page_id, video_id, message, headline, link_url, cta_type, thumbnail_url }) => {
      try {
        const video_data = {
          video_id, message,
          title: headline,
          call_to_action: { type: cta_type, value: { link: link_url } }
        };
        if (thumbnail_url) video_data.image_url = thumbnail_url;

        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", {
          name, object_story_spec: { page_id, video_data }
        });
        return ok(`✓ Creative video creat!\nID: ${d.id}\n\nPasul urmator → create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_carousel_creative",
    "Pas 4c/5: Creeaza creative tip carousel (2-10 carduri cu imagini diferite). Ideal pentru prezentarea mai multor produse.",
    {
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      message: z.string().max(500).describe("Textul principal deasupra carousel-ului"),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","GET_QUOTE"]).default("LEARN_MORE"),
      cards: z.array(z.object({
        image_hash: z.string().describe("Hash imagine pentru acest card"),
        headline: z.string().max(40).describe("Titlul cardului"),
        description: z.string().max(30).optional(),
        link_url: z.string().url().describe("URL cardului")
      })).min(2).max(10).describe("Cardurile carousel (minim 2, maxim 10)")
    },
    async ({ name, page_id, message, cta_type, cards }) => {
      try {
        const child_attachments = cards.map(c => ({
          link: c.link_url,
          image_hash: c.image_hash,
          name: c.headline,
          description: c.description || "",
          call_to_action: { type: cta_type, value: { link: c.link_url } }
        }));

        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", {
          name,
          object_story_spec: {
            page_id,
            link_data: {
              message,
              link: cards[0].link_url,
              child_attachments,
              multi_share_optimized: true
            }
          }
        });
        return ok(`✓ Creative carousel creat!\nID: ${d.id}\nCarduri: ${cards.length}\n\nPasul urmator → create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_ad",
    "Pas 5/5: Creeaza Ad-ul final — leaga Ad Set-ul cu Creative-ul. Campania ramane PAUSED pana o activezi manual.",
    {
      adset_id: z.string().describe("ID Ad Set din create_adset"),
      creative_id: z.string().describe("ID creative din create_creative / create_video_creative / create_carousel_creative"),
      name: z.string().describe("Numele Ad-ului")
    },
    async ({ adset_id, creative_id, name }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/ads`, "POST", {
          adset_id, creative: { creative_id }, name, status: "PAUSED"
        });
        return ok(`✓ Ad creat cu succes! Campania este gata.\nID: ${d.id}\nNume: ${name}\nStatus: PAUSED\n\nACTIUNE: Activeaza campania din Meta Ads Manager sau cu update_campaign_status.`);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 5 — MANAGEMENT CAMPANII
  // ═══════════════════════════════════════════════════════════════════

  server.tool("update_campaign_status",
    "Activeaza sau pauzeaza o campanie",
    {
      campaign_id: z.string(),
      status: z.enum(["ACTIVE","PAUSED"])
    },
    async ({ campaign_id, status }) => {
      try {
        await meta(`/${campaign_id}`, "POST", { status });
        return ok(`${status === "ACTIVE" ? "▶" : "⏸"} Campania ${campaign_id} → ${status}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("update_campaign_budget",
    "Modifica bugetul zilnic al unei campanii (in CENTI USD)",
    {
      campaign_id: z.string(),
      daily_budget: z.number().describe("Buget zilnic in CENTI USD (ex: 2000 = $20)")
    },
    async ({ campaign_id, daily_budget }) => {
      try {
        await meta(`/${campaign_id}`, "POST", { daily_budget });
        return ok(`✓ Buget actualizat: ${(daily_budget/100).toFixed(2)}$/zi pentru campania ${campaign_id}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("update_adset",
    "Modifica un Ad Set: buget, status, bid sau data de sfarsit",
    {
      adset_id: z.string(),
      status: z.enum(["ACTIVE","PAUSED"]).optional(),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD"),
      bid_amount: z.number().optional().describe("Bid in CENTI USD"),
      end_time: z.string().optional().describe("Data sfarsit ISO 8601")
    },
    async ({ adset_id, status, daily_budget, bid_amount, end_time }) => {
      try {
        const body = {};
        if (status)       body.status = status;
        if (daily_budget) body.daily_budget = daily_budget;
        if (bid_amount)   body.bid_amount = bid_amount;
        if (end_time)     body.end_time = end_time;
        if (!Object.keys(body).length) return ok("Nicio modificare specificata.");
        await meta(`/${adset_id}`, "POST", body);
        return ok(`✓ Ad Set ${adset_id} actualizat.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("pause_ad",
    "Pauzeaza sau activeaza un Ad individual",
    {
      ad_id: z.string(),
      status: z.enum(["ACTIVE","PAUSED"])
    },
    async ({ ad_id, status }) => {
      try {
        await meta(`/${ad_id}`, "POST", { status });
        return ok(`${status === "ACTIVE" ? "▶" : "⏸"} Ad ${ad_id} → ${status}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("duplicate_campaign",
    "Duplica o campanie existenta recreand-o manual cu aceleasi setari. Ad Set-urile si Ad-urile trebuie recreate separat.",
    {
      campaign_id: z.string().describe("ID campanie de copiat"),
      new_name: z.string().describe("Numele noii campanii")
    },
    async ({ campaign_id, new_name }) => {
      try {
        // Fetch original campaign
        const orig = await meta(`/${campaign_id}?fields=name,objective,daily_budget,lifetime_budget,special_ad_categories,stop_time`);
        const body = {
          name: new_name,
          objective: orig.objective,
          status: "PAUSED",
          special_ad_categories: orig.special_ad_categories || []
        };
        if (orig.daily_budget)    body.daily_budget = parseInt(orig.daily_budget);
        if (orig.lifetime_budget) body.lifetime_budget = parseInt(orig.lifetime_budget);
        if (orig.stop_time)       body.stop_time = orig.stop_time;

        const d = await meta(`/act_${ACCOUNT}/campaigns`, "POST", body);

        // Fetch original adsets
        const adsets = await meta(`/${campaign_id}/adsets?fields=name,daily_budget,targeting,optimization_goal,billing_event,bid_strategy&limit=50`);
        let adsetCount = 0;
        for (const as of (adsets.data || [])) {
          const asBody = {
            campaign_id: d.id,
            name: as.name,
            targeting: as.targeting,
            optimization_goal: as.optimization_goal,
            billing_event: as.billing_event,
            bid_strategy: as.bid_strategy || "LOWEST_COST_WITHOUT_CAP",
            status: "PAUSED"
          };
          if (as.daily_budget) asBody.daily_budget = parseInt(as.daily_budget);
          try {
            await meta(`/act_${ACCOUNT}/adsets`, "POST", asBody);
            adsetCount++;
          } catch (_) { /* skip failed adsets */ }
        }

        return ok(`✓ Campanie duplicata!\nID nou: ${d.id}\nNume: ${new_name}\nAd Sets copiate: ${adsetCount}/${(adsets.data||[]).length}\nNota: Ad-urile si creativele trebuie adaugate manual.`);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 6 — TARGETING & AUDIENTA
  // ═══════════════════════════════════════════════════════════════════

  server.tool("search_interests",
    "Cauta interese pentru targeting Meta Ads. Returneaza ID-urile necesare pentru create_adset.",
    {
      query: z.string().describe("Termen de cautat (ex: fitness, imobiliare, antreprenoriat)"),
      limit: z.number().default(15)
    },
    async ({ query, limit }) => {
      try {
        const d = await meta(`/search?type=adinterest&q=${encodeURIComponent(query)}&limit=${limit}&locale=en_US`);
        const items = d.data || [];
        if (!items.length) return ok(`Niciun interes gasit pentru "${query}". Incearca termeni mai generali sau in engleza.`);
        const lines = items.map(i => {
          const low  = (i.audience_size_lower_bound || 0).toLocaleString();
          const high = (i.audience_size_upper_bound || 0).toLocaleString();
          return `ID: ${i.id} | ${i.name} | Audienta: ${low} - ${high}`;
        });
        return ok(`Interese pentru "${query}" (${items.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("search_locations",
    "Cauta locatii pentru targeting geografic: orase, regiuni, tari",
    {
      query: z.string().describe("Numele locatiei (ex: Bucuresti, Cluj-Napoca, Romania)"),
      location_types: z.array(z.enum(["country","region","city","zip"])).default(["country","region","city"])
    },
    async ({ query, location_types }) => {
      try {
        const typesParam = location_types.map(t => `"${t}"`).join(",");
        const d = await meta(`/search?type=adgeolocation&q=${encodeURIComponent(query)}&location_types=[${typesParam}]&limit=15`);
        const items = d.data || [];
        if (!items.length) return ok(`Nicio locatie gasita pentru "${query}".`);
        const lines = items.map(i => `${i.type.toUpperCase()}: ${i.name}${i.region ? ", " + i.region : ""} | Tara: ${i.country_code || i.country_name || "-"} | Key: ${i.key}`);
        return ok(`Locatii (${items.length}):\n${lines.join("\n")}\n\nFoloseste "key" in campul countries/cities al create_adset.`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_custom_audiences",
    "Listeaza audientele personalizate si lookalike din cont",
    {},
    async () => {
      try {
        const fields = "id,name,subtype,approximate_count,delivery_status";
        const d = await meta(`/act_${ACCOUNT}/customaudiences?fields=${fields}&limit=50`);
        const audiences = d.data || [];
        if (!audiences.length) return ok("Nu exista audionte personalizate in cont.");
        const lines = audiences.map(a => {
          const count = a.approximate_count ? parseInt(a.approximate_count).toLocaleString() : "?";
          return `ID: ${a.id} | ${a.name} | ${a.subtype} | ~${count} persoane`;
        });
        return ok(`Audionte personalizate (${audiences.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_lookalike_audience",
    "Creeaza o audienta Lookalike bazata pe o audienta existenta. Ideal pentru extinderea audientei cu persoane similare.",
    {
      source_audience_id: z.string().describe("ID-ul audientei sursa (din list_custom_audiences)"),
      name: z.string().describe("Numele noii audionte lookalike"),
      country: z.string().default("RO").describe("Codul tarii pentru lookalike (ex: RO, MD, US)"),
      ratio: z.number().min(0.01).max(0.20).default(0.02).describe("Procentul din populatia tarii (0.01 = 1%, 0.20 = 20%). Mai mic = mai similar.")
    },
    async ({ source_audience_id, name, country, ratio }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/customaudiences`, "POST", {
          name,
          subtype: "LOOKALIKE",
          origin_audience_id: source_audience_id,
          lookalike_spec: {
            type: "similarity",
            ratio,
            country
          }
        });
        return ok(`✓ Audienta Lookalike creata!\nID: ${d.id}\nNume: ${name}\nTara: ${country} | Ratio: ${(ratio*100).toFixed(0)}%`);
      } catch (e) { return err(e); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // BLOC 7 — LEAD FORMS
  // ═══════════════════════════════════════════════════════════════════

  server.tool("list_lead_forms",
    "Listeaza formularele de lead generation ale unei pagini Facebook",
    { page_id: z.string().describe("ID-ul paginii Facebook din get_pages") },
    async ({ page_id }) => {
      try {
        const d = await meta(`/${page_id}/leadgen_forms?fields=id,name,status,leads_count,created_time&limit=25`);
        const forms = d.data || [];
        if (!forms.length) return ok("Nu exista formulare Lead Gen pe aceasta pagina.");
        const lines = forms.map(f => `ID: ${f.id} | ${f.name} | ${f.status} | ${f.leads_count || 0} leads`);
        return ok(`Formulare Lead Gen (${forms.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_lead_submissions",
    "Descarca lead-urile dintr-un formular. Returneaza datele completate de utilizatori.",
    {
      form_id: z.string().describe("ID formular din list_lead_forms"),
      limit: z.number().default(50).describe("Numar maxim de lead-uri (max 100)")
    },
    async ({ form_id, limit }) => {
      try {
        const d = await meta(`/${form_id}/leads?fields=id,created_time,field_data&limit=${Math.min(limit, 100)}`);
        const leads = d.data || [];
        if (!leads.length) return ok("Niciun lead gasit in acest formular.");
        const lines = leads.map(lead => {
          const date   = new Date(lead.created_time).toLocaleString("ro-RO");
          const fields = (lead.field_data || []).map(f => `${f.name}: ${(f.values||[]).join(", ")}`).join(" | ");
          return `${date} | ${fields}`;
        });
        return ok(`Lead-uri (${leads.length}):\n${lines.join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  return server;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => server.close().catch(() => {}));
  } catch (e) {
    console.error("MCP error:", e.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
    }
  }
});

app.get("/mcp", (_, res) => res.status(405).send("POST /mcp only"));

app.get("/health", (_, res) => res.json({
  status: "ok",
  server: "meta-ads-mcp",
  version: "2.1.0",
  account: ACCOUNT ? `act_${ACCOUNT}` : "NOT SET",
  token: TOKEN ? "configured" : "NOT SET",
  api: API
}));

app.listen(PORT, () => {
  console.log(`Meta Ads MCP Server v2.1 running on port ${PORT}`);
  if (!TOKEN)   console.error("MISSING: META_ADS_ACCESS_TOKEN");
  if (!ACCOUNT) console.error("MISSING: META_AD_ACCOUNT_ID");
});
