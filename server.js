/**
 * Meta Ads MCP Server v2.8.0-Final
 * Compatible cu Claude.ai custom connectors — Streamable HTTP transport
 * Meta Marketing API v25.0 (Feb 2026)
 * 31 tools: analiza, creare campanii, creative, audienta, lead forms
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const TOKEN   = process.env.META_ADS_ACCESS_TOKEN;
const ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const API     = "https://graph.facebook.com/v25.0";
const PORT    = process.env.PORT || 3000;

async function meta(path, method = "GET", body = null) {
  if (!TOKEN)   throw new Error("META_ADS_ACCESS_TOKEN lipsa din Railway Variables");
  if (!ACCOUNT && !path.startsWith("/me") && !path.match(/^\/\d{10,}/)) {
    throw new Error("META_AD_ACCOUNT_ID lipsa din Railway Variables");
  }
  const base    = path.startsWith("http") ? path : `${API}${path}`;
  const fullUrl = `${base}${base.includes("?") ? "&" : "?"}access_token=${TOKEN}`;
  const opts    = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(fullUrl, opts); } catch (e) { throw new Error(`Retea: ${e.message}`); }
  const data = await res.json();
  if (data.error) {
    const code = data.error.code || data.error.error_code || "?";
    const msg  = data.error.error_user_msg || data.error.error_message || data.error.message;
    const sub  = data.error.error_subcode ? ` [sub:${data.error.error_subcode}]` : "";
    throw new Error(`Meta API [${code}]${sub}: ${msg}`);
  }
  return data;
}

const ok   = (t) => ({ content: [{ type: "text", text: String(t) }] });
const err  = (e) => ({ content: [{ type: "text", text: `Eroare: ${e.message}` }], isError: true });
const json = (o) => ok(JSON.stringify(o, null, 2));

function createServer() {
  const server = new McpServer({ name: "meta-ads-mcp", version: "2.8.0-Final" });

  // ── CONT ─────────────────────────────────────────────────────────────────
  server.tool("get_account_info",
    "Informatii cont: status, valuta, cheltuieli totale, business manager",
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}?fields=id,name,account_status,currency,timezone_name,amount_spent,business`);
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
    {},
    async () => {
      try {
        let pages = [];
        try {
          const d = await meta(`/me/accounts?fields=id,name,category,fan_count&limit=50`);
          pages = d.data || [];
        } catch {
          const biz = await meta(`/act_${ACCOUNT}?fields=business`);
          if (biz.business) {
            const d = await meta(`/${biz.business.id}/owned_pages?fields=id,name,category,fan_count&limit=50`);
            pages = d.data || [];
          }
        }
        if (!pages.length) return ok("Nicio pagina Facebook gasita. Verifica Business Manager.");
        return ok(`Pagini (${pages.length}):\n${pages.map(p=>`ID: ${p.id} | ${p.name} | ${p.category}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_pixels",
    "Listeaza pixelii Meta. Necesar pentru campanii cu OFFSITE_CONVERSIONS.",
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adspixels?fields=id,name,last_fired_time&limit=25`);
        const p = d.data || [];
        if (!p.length) return ok("Niciun pixel gasit. Creeaza unul in Meta Events Manager.");
        return ok(`Pixeli (${p.length}):\n${p.map(x=>{
          const last = x.last_fired_time ? new Date(x.last_fired_time*1000).toLocaleDateString("ro-RO") : "Niciodata";
          return `ID: ${x.id} | ${x.name} | Ultimul foc: ${last}`;
        }).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_instagram_accounts",
    "Listeaza conturile Instagram conectate.",
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}/instagram_accounts?fields=id,username&limit=25`);
        const a = d.data || [];
        if (!a.length) return ok("Niciun cont Instagram conectat.");
        return ok(`Instagram (${a.length}):\n${a.map(x=>`ID: ${x.id} | @${x.username}`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── CITIRE CAMPANII ───────────────────────────────────────────────────────
  server.tool("list_campaigns",
    "Listeaza campaniile din cont cu status, obiectiv si buget",
    { status: z.enum(["ACTIVE","PAUSED","ALL"]).default("ALL") },
    async ({ status }) => {
      try {
        const f = status === "ALL" ? "" : `&effective_status=["${status}"]`;
        const d = await meta(`/act_${ACCOUNT}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget${f}&limit=100`);
        const c = d.data || [];
        if (!c.length) return ok("Nu exista campanii.");
        return ok(`Campanii (${c.length}):\n${c.map(x=>{
          const b = x.daily_budget ? `${(x.daily_budget/100).toFixed(2)}$/zi` : x.lifetime_budget ? `${(x.lifetime_budget/100).toFixed(2)}$ total` : "-";
          return `ID: ${x.id} | ${x.name} | ${x.status} | ${x.objective} | ${b}`;
        }).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_adsets",
    "Listeaza Ad Set-urile dintr-o campanie cu buget, targeting si status",
    { campaign_id: z.string().describe("ID-ul campaniei") },
    async ({ campaign_id }) => {
      try {
        const d = await meta(`/${campaign_id}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal&limit=100`);
        return json(d.data || []);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_ads",
    "Listeaza Ad-urile dintr-un Ad Set cu status si creative",
    { adset_id: z.string().describe("ID-ul Ad Set-ului") },
    async ({ adset_id }) => {
      try {
        const d = await meta(`/${adset_id}/ads?fields=id,name,status,creative{id,name}&limit=100`);
        return json(d.data || []);
      } catch (e) { return err(e); }
    }
  );

  server.tool("list_images",
    "Listeaza imaginile uploadate in cont. Reutilizeaza hash-ul pentru creative noi.",
    { limit: z.number().default(25) },
    async ({ limit }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adimages?fields=hash,name,url,width,height,status&limit=${limit}`);
        const i = d.data || [];
        if (!i.length) return ok("Nu exista imagini uploadate.");
        return ok(`Imagini (${i.length}):\n${i.map(x=>`Hash: ${x.hash} | ${x.name||"fara_nume"} | ${x.width}x${x.height}px`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  // ── INSIGHTS ─────────────────────────────────────────────────────────────
  server.tool("get_all_insights",
    "Raport complet CPL/ROAS pentru toate campaniile. Foloseste pentru monitorizare zilnica.",
    {
      date_preset: z.enum(["today","yesterday","last_7d","last_14d","last_30d","last_90d"]).default("last_7d"),
      level: z.enum(["campaign","adset","ad"]).default("campaign")
    },
    async ({ date_preset, level }) => {
      try {
        const fields = "campaign_name,campaign_id,adset_name,adset_id,spend,impressions,clicks,reach,frequency,ctr,cpc,actions,cost_per_action_type";
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=${level}&limit=200`);
        const rows = d.data || [];
        if (!rows.length) return ok("Nu exista date pentru perioada selectata.");
        return json(rows);
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
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_7d"),
      cpl_threshold: z.number().default(3).describe("Prag CPL in dolari — ad set-urile peste acest prag sunt ineficiente")
    },
    async ({ date_preset, cpl_threshold }) => {
      try {
        const fields = "campaign_name,adset_name,spend,actions,cost_per_action_type,impressions";
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=adset&limit=200`);
        const rows = d.data || [];
        const wasted = [], good = [];
        for (const r of rows) {
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
      date_preset: z.enum(["last_7d","last_14d","last_30d"]).default("last_14d"),
      frequency_threshold: z.number().default(2.5).describe("Frecventa peste care creativul e considerat obosit")
    },
    async ({ date_preset, frequency_threshold }) => {
      try {
        const fields = "ad_name,ad_id,campaign_name,adset_name,spend,frequency,ctr,reach";
        const d = await meta(`/act_${ACCOUNT}/insights?fields=${fields}&date_preset=${date_preset}&level=ad&limit=200`);
        const rows = d.data || [];
        const fatigued = rows.filter(r=>parseFloat(r.frequency||0)>=frequency_threshold).sort((a,b)=>parseFloat(b.frequency)-parseFloat(a.frequency));
        const fine = rows.filter(r=>parseFloat(r.frequency||0)<frequency_threshold);
        let out = `=== FATIGUE CREATIVE (prag: ${frequency_threshold}) ===\n\nOBOSITE (${fatigued.length}):\n`;
        fatigued.forEach(r => out += `  ! ${r.ad_name}\n    ${r.campaign_name} | Frecventa: ${parseFloat(r.frequency).toFixed(1)} | CTR: ${parseFloat(r.ctr||0).toFixed(2)}%\n\n`);
        out += `OK (${fine.length}) — frecventa sub prag\n`;
        return ok(out);
      } catch (e) { return err(e); }
    }
  );

  // ── CREARE CAMPANIE ───────────────────────────────────────────────────────
  server.tool("create_campaign",
    "Pas 1/5: Creeaza o campanie noua (PAUSED). Returneaza campaign_id pentru create_adset.",
    {
      name: z.string().describe("Numele campaniei"),
      objective: z.enum(["OUTCOME_LEADS","OUTCOME_SALES","OUTCOME_TRAFFIC","OUTCOME_AWARENESS","OUTCOME_ENGAGEMENT","OUTCOME_APP_PROMOTION"]).describe("Obiectivul campaniei"),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD (1000=$10). Nu combina cu lifetime_budget. Lasa gol daca vrei buget per ad set."),
      lifetime_budget: z.number().optional().describe("Buget total in CENTI USD. Necesita stop_time."),
      stop_time: z.string().optional().describe("Data sfarsit ISO 8601. Necesar cu lifetime_budget."),
      special_ad_categories: z.array(z.string()).default([]).describe("Categorii speciale: CREDIT, EMPLOYMENT, HOUSING. Lasa gol in mod normal.")
    },
    async ({ name, objective, daily_budget, lifetime_budget, stop_time, special_ad_categories }) => {
      try {
        if (daily_budget && lifetime_budget) throw new Error("Foloseste fie daily_budget fie lifetime_budget, nu ambele.");
        if (lifetime_budget && !stop_time) throw new Error("lifetime_budget necesita stop_time.");
        const body = { name, objective, status: "PAUSED", special_ad_categories };
        if (daily_budget)    body.daily_budget = daily_budget;
        if (lifetime_budget) body.lifetime_budget = lifetime_budget;
        if (stop_time)       body.stop_time = stop_time;
        const d = await meta(`/act_${ACCOUNT}/campaigns`, "POST", body);
        return ok(`Campanie creata!\nID: ${d.id}\nNume: ${name}\nObiectiv: ${objective}\nStatus: PAUSED\n\nPasul urmator: create_adset cu campaign_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_adset",
    "Pas 2/5: Creeaza un Ad Set cu targeting complet. Returneaza adset_id pentru create_ad.",
    {
      campaign_id: z.string().describe("ID campanie din create_campaign"),
      name: z.string().describe("Numele Ad Set-ului"),
      advantage_audience: z.union([z.literal(0), z.literal(1)]).describe("OBLIGATORIU (Meta API v25). 0=targeting MANUAL exact (varsta/gen/interese respectate strict). 1=Advantage+ AI (Meta extinde automat audienta). Alege 0 pentru audienta specifica, 1 pentru lead gen broad."),
      daily_budget: z.number().optional().describe("Buget zilnic in CENTI USD (1000=$10). Lasa gol daca campania are CBO."),
      age_min: z.number().default(18).describe("Varsta minima (18-65)"),
      age_max: z.number().default(65).describe("Varsta maxima (18-65)"),
      genders: z.array(z.number()).default([1,2]).describe("1=Barbati 2=Femei [1,2]=Ambele"),
      countries: z.array(z.string()).default(["RO"]).describe("Coduri ISO 2 (ex: ['RO','MD'])"),
      optimization_goal: z.enum(["LEAD_GENERATION","LINK_CLICKS","IMPRESSIONS","REACH","OFFSITE_CONVERSIONS","LANDING_PAGE_VIEWS","THRUPLAY"]).default("LEAD_GENERATION"),
      billing_event: z.enum(["IMPRESSIONS","LINK_CLICKS","THRUPLAY"]).default("IMPRESSIONS"),
      bid_strategy: z.enum(["LOWEST_COST_WITHOUT_CAP","LOWEST_COST_WITH_BID_CAP","COST_CAP"]).optional().describe("Lasa gol pentru lowest cost fara cap (default Meta). Specifica doar daca vrei LOWEST_COST_WITH_BID_CAP sau COST_CAP (necesita bid_amount)."),
      bid_amount: z.number().optional().describe("Bid in CENTI USD. Necesar pentru LOWEST_COST_WITH_BID_CAP si COST_CAP."),
      interest_ids: z.array(z.string()).optional().describe("ID-uri interese din search_interests (ex: ['6003107902433'])"),
      pixel_id: z.string().optional().describe("ID pixel din list_pixels. Necesar pentru OFFSITE_CONVERSIONS."),
      end_time: z.string().optional().describe("Data sfarsit ISO 8601"),
      is_adset_budget_sharing_enabled: z.boolean().default(true).describe("v24.0+: Permite partajarea bugetului intre ad set-uri. Obligatoriu cand setezi budget la ad set. Default: true.")
    },
    async ({ campaign_id, name, advantage_audience, daily_budget, age_min, age_max, genders, countries,
             optimization_goal, billing_event, bid_strategy, bid_amount, interest_ids, pixel_id,
             end_time, is_adset_budget_sharing_enabled }) => {
      try {
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
        const d = await meta(`/act_${ACCOUNT}/adsets`, "POST", body);
        const bStr = daily_budget ? `${(daily_budget/100).toFixed(2)}$/zi` : "din campanie";
        return ok(`Ad Set creat!\nID: ${d.id}\nNume: ${name}\nBuget: ${bStr}\nAudienta: ${advantage_audience===0?"Manual":"Advantage+ AI"}\nStatus: PAUSED\n\nPasul urmator: upload_image sau create_creative cu adset_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_image",
    "Pas 3a/5: Uploadeaza imagine din URL. Returneaza image_hash pentru create_creative.\nGoogle Drive: Share > Anyone with link → https://drive.google.com/uc?export=download&id=FILE_ID",
    { image_url: z.string().url().describe("URL public direct al imaginii") },
    async ({ image_url }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/adimages`, "POST", { url: image_url });
        const img = Object.values(d.images || {})[0];
        if (!img) throw new Error("Upload esuat. Verifica ca URL-ul returneaza direct imaginea si nu o pagina HTML.");
        return ok(`Imagine uploadata!\nHash: ${img.hash}\nDimensiune: ${img.width}x${img.height}px\n\nPasul urmator: create_creative cu image_hash="${img.hash}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("upload_video",
    "Pas 3b/5: Uploadeaza video din URL. Returneaza video_id pentru create_video_creative.",
    {
      video_url: z.string().url().describe("URL public direct al fisierului video (MP4, max 4GB)"),
      title: z.string().default("Video Ad")
    },
    async ({ video_url, title }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/advideos`, "POST", { file_url: video_url, title });
        return ok(`Video uploadat!\nID: ${d.id}\nTitlu: ${title}\n\nPasul urmator: create_video_creative cu video_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_creative",
    "Pas 4a/5: Creeaza creative cu imagine. Returneaza creative_id pentru create_ad.",
    {
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
    async ({ name, page_id, image_hash, message, headline, description, link_url, cta_type, instagram_actor_id }) => {
      try {
        const link_data = { image_hash, link: link_url, message, name: headline, description: description||"", call_to_action: { type: cta_type, value: { link: link_url } } };
        const spec = { page_id, link_data };
        if (instagram_actor_id) spec.instagram_actor_id = instagram_actor_id;
        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", { name, object_story_spec: spec });
        return ok(`Creative creat!\nID: ${d.id}\nNume: ${name}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_video_creative",
    "Pas 4b/5: Creeaza creative cu video. Thumbnail preluat automat din video daca nu e specificat.",
    {
      name: z.string(),
      page_id: z.string().describe("ID pagina Facebook din get_pages"),
      video_id: z.string().describe("ID video din upload_video"),
      message: z.string().max(500),
      headline: z.string().max(40),
      link_url: z.string().url(),
      cta_type: z.enum(["LEARN_MORE","SHOP_NOW","SIGN_UP","CONTACT_US","WATCH_MORE","DOWNLOAD"]).default("LEARN_MORE"),
      thumbnail_url: z.string().url().optional().describe("URL thumbnail custom. Daca lipseste, serverul il preia automat din video.")
    },
    async ({ name, page_id, video_id, message, headline, link_url, cta_type, thumbnail_url }) => {
      try {
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
        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", { name, object_story_spec: { page_id, video_data } });
        const tInfo = thumb ? (thumbnail_url ? "thumbnail custom" : "thumbnail auto din video") : "fara thumbnail";
        return ok(`Creative video creat!\nID: ${d.id}\nThumbnail: ${tInfo}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_carousel_creative",
    "Pas 4c/5: Creeaza creative carousel (2-10 carduri). Ideal pentru mai multe produse.",
    {
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
    async ({ name, page_id, message, cta_type, cards }) => {
      try {
        const child_attachments = cards.map(c => ({
          link: c.link_url, image_hash: c.image_hash, name: c.headline,
          description: c.description||"", call_to_action: { type: cta_type, value: { link: c.link_url } }
        }));
        const d = await meta(`/act_${ACCOUNT}/adcreatives`, "POST", { name, object_story_spec: { page_id, link_data: { message, link: cards[0].link_url, child_attachments, multi_share_optimized: true } } });
        return ok(`Creative carousel creat!\nID: ${d.id}\nCarduri: ${cards.length}\n\nPasul urmator: create_ad cu creative_id="${d.id}"`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_ad",
    "Pas 5/5: Creeaza Ad-ul final — leaga Ad Set-ul cu Creative-ul. Campania ramane PAUSED pana o activezi manual.",
    {
      adset_id: z.string().describe("ID Ad Set din create_adset"),
      creative_id: z.string().describe("ID creative din create_creative / create_video_creative / create_carousel_creative"),
      name: z.string().describe("Numele Ad-ului"),
      multi_advertiser_ads: z.boolean().default(true).describe("Multi-advertiser ads: true=activat (Meta afiseaza reclama alaturi de alte reclame similare), false=dezactivat (reclama apare singura). Dezactiveaza daca vrei control complet asupra plasamentului."),
      url_tags: z.string().optional().describe("Parametri UTM pentru tracking (ex: 'utm_source=facebook&utm_medium=paid&utm_campaign=test')"),
      conversion_domain: z.string().optional().describe("Domeniul de conversie (ex: 'exemplu.ro'). Recomandat pentru campanii cu pixel.")
    },
    async ({ adset_id, creative_id, name, multi_advertiser_ads, url_tags, conversion_domain }) => {
      try {
        const body = {
          adset_id,
          creative: { creative_id },
          name,
          status: "PAUSED",
          multi_advertiser_eligibility: multi_advertiser_ads ? "eligible" : "not_eligible"
        };
        if (url_tags)          body.creative = { ...body.creative, url_tags };
        if (conversion_domain) body.conversion_domain = conversion_domain;
        const d = await meta(`/act_${ACCOUNT}/ads`, "POST", body);
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
      countries: z.array(z.string()).optional().describe("Inlocuieste targetingul geografic (ex: ['RO','MD'])"),
      age_min: z.number().optional().describe("Noua varsta minima (18-65)"),
      age_max: z.number().optional().describe("Noua varsta maxima (18-65)"),
      genders: z.array(z.number()).optional().describe("1=Barbati 2=Femei [1,2]=Ambele"),
      interest_ids: z.array(z.string()).optional().describe("Inlocuieste interesele cu aceste ID-uri din search_interests")
    },
    async ({ adset_id, status, name, daily_budget, bid_amount, end_time, countries, age_min, age_max, genders, interest_ids }) => {
      try {
        const body = {};
        if (status)       body.status = status;
        if (name)         body.name = name;
        if (daily_budget) body.daily_budget = daily_budget;
        if (bid_amount)   body.bid_amount = bid_amount;
        if (end_time)     body.end_time = end_time;
        if (countries || age_min !== undefined || age_max !== undefined || genders || interest_ids) {
          const current = await meta(`/${adset_id}?fields=targeting`);
          const targeting = { ...(current.targeting || {}) };
          if (countries)             targeting.geo_locations = { ...targeting.geo_locations, countries };
          if (age_min !== undefined) targeting.age_min = age_min;
          if (age_max !== undefined) targeting.age_max = age_max;
          if (genders)               targeting.genders = genders;
          if (interest_ids?.length)  targeting.flexible_spec = [{ interests: interest_ids.map(id => ({ id })) }];
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
    "Modifica un Ad existent: status, nume, creative, multi-advertiser ads si alte optiuni",
    {
      ad_id: z.string().describe("ID-ul Ad-ului de modificat"),
      status: z.enum(["ACTIVE","PAUSED"]).optional().describe("Activeaza sau pauzeaza ad-ul"),
      name: z.string().optional().describe("Noul nume al Ad-ului"),
      creative_id: z.string().optional().describe("ID-ul noului creative. Inlocuieste creative-ul existent."),
      multi_advertiser_ads: z.boolean().optional().describe("Multi-advertiser ads: true=activat, false=dezactivat. Dezactiveaza daca vrei reclama sa apara singura, fara reclame similare alaturi."),
      conversion_domain: z.string().optional().describe("Actualizeaza domeniul de conversie (ex: 'exemplu.ro')")
    },
    async ({ ad_id, status, name, creative_id, multi_advertiser_ads, conversion_domain }) => {
      try {
        const body = {};
        if (status)      body.status = status;
        if (name)        body.name = name;
        if (creative_id) body.creative = { creative_id };
        if (multi_advertiser_ads !== undefined) body.multi_advertiser_eligibility = multi_advertiser_ads ? "eligible" : "not_eligible";
        if (conversion_domain) body.conversion_domain = conversion_domain;
        if (!Object.keys(body).length) return ok("Nicio modificare specificata.");
        await meta(`/${ad_id}`, "POST", body);
        const changes = Object.keys(body).map(k => {
          if (k === "multi_advertiser_eligibility") return `multi_advertiser: ${body[k]}`;
          return k;
        }).join(", ");
        return ok(`Ad ${ad_id} actualizat.\nCampuri modificate: ${changes}`);
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
        const orig = await meta(`/${campaign_id}?fields=name,objective,daily_budget,lifetime_budget,special_ad_categories,stop_time`);
        const body = { name: new_name, objective: orig.objective, status: "PAUSED", special_ad_categories: orig.special_ad_categories||[] };
        if (orig.daily_budget)    body.daily_budget = parseInt(orig.daily_budget);
        if (orig.lifetime_budget) body.lifetime_budget = parseInt(orig.lifetime_budget);
        if (orig.stop_time)       body.stop_time = orig.stop_time;
        const d = await meta(`/act_${ACCOUNT}/campaigns`, "POST", body);
        const adsets = await meta(`/${campaign_id}/adsets?fields=name,daily_budget,targeting,optimization_goal,billing_event,bid_strategy&limit=50`);
        let copied = 0;
        for (const as of (adsets.data||[])) {
          try {
            const ab = { campaign_id: d.id, name: as.name, targeting: as.targeting, optimization_goal: as.optimization_goal, billing_event: as.billing_event, bid_strategy: as.bid_strategy||"LOWEST_COST_WITHOUT_CAP", status: "PAUSED" };
            if (as.daily_budget) ab.daily_budget = parseInt(as.daily_budget);
            await meta(`/act_${ACCOUNT}/adsets`, "POST", ab);
            copied++;
          } catch {}
        }
        return ok(`Campanie duplicata!\nID nou: ${d.id}\nNume: ${new_name}\nAd Sets copiate: ${copied}/${(adsets.data||[]).length}`);
      } catch (e) { return err(e); }
    }
  );

  // ── TARGETING ─────────────────────────────────────────────────────────────
  server.tool("search_interests",
    "Cauta interese pentru targeting. NOTA: Din oct 2025 interesele sunt consolidate in categorii mai largi. Interesele vechi nu functioneaza din ian 2026.",
    { query: z.string().describe("Termen de cautat (ex: fitness, imobiliare, antreprenoriat)"), limit: z.number().default(15) },
    async ({ query, limit }) => {
      try {
        const d = await meta(`/search?type=adinterest&q=${encodeURIComponent(query)}&limit=${limit}&locale=en_US`);
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
    {},
    async () => {
      try {
        const d = await meta(`/act_${ACCOUNT}/customaudiences?fields=id,name,subtype,approximate_count&limit=50`);
        const a = d.data || [];
        if (!a.length) return ok("Nu exista audionte personalizate.");
        return ok(`Audionte (${a.length}):\n${a.map(x=>`ID: ${x.id} | ${x.name} | ${x.subtype} | ~${(x.approximate_count||0).toLocaleString()} persoane`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("create_lookalike_audience",
    "Creeaza o audienta Lookalike bazata pe o audienta existenta.",
    {
      source_audience_id: z.string().describe("ID audienta sursa din list_custom_audiences"),
      name: z.string(),
      country: z.string().default("RO").describe("Codul tarii (ex: RO, MD, US)"),
      ratio: z.number().min(0.01).max(0.20).default(0.02).describe("Procentul din populatie (0.01=1%, 0.20=20%). Mai mic = mai similar.")
    },
    async ({ source_audience_id, name, country, ratio }) => {
      try {
        const d = await meta(`/act_${ACCOUNT}/customaudiences`, "POST", { name, subtype: "LOOKALIKE", origin_audience_id: source_audience_id, lookalike_spec: { type: "similarity", ratio, country } });
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
        const d = await meta(`/${page_id}/leadgen_forms?fields=id,name,status,leads_count,created_time&limit=25`);
        const f = d.data || [];
        if (!f.length) return ok("Nu exista formulare Lead Gen pe aceasta pagina.");
        return ok(`Formulare (${f.length}):\n${f.map(x=>`ID: ${x.id} | ${x.name} | ${x.status} | ${x.leads_count||0} leads`).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  server.tool("get_lead_submissions",
    "Descarca lead-urile dintr-un formular Lead Gen.",
    {
      form_id: z.string().describe("ID formular din list_lead_forms"),
      limit: z.number().default(50).describe("Numar maxim de lead-uri (max 100)")
    },
    async ({ form_id, limit }) => {
      try {
        const d = await meta(`/${form_id}/leads?fields=id,created_time,field_data&limit=${Math.min(limit,100)}`);
        const leads = d.data || [];
        if (!leads.length) return ok("Niciun lead gasit.");
        return ok(`Lead-uri (${leads.length}):\n${leads.map(l=>{
          const date = new Date(l.created_time).toLocaleString("ro-RO");
          const fields = (l.field_data||[]).map(f=>`${f.name}: ${(f.values||[]).join(", ")}`).join(" | ");
          return `${date} | ${fields}`;
        }).join("\n")}`);
      } catch (e) { return err(e); }
    }
  );

  return server;
}

// ── Express ───────────────────────────────────────────────────────────────────
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
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
  }
});

app.get("/mcp", (_, res) => res.status(405).send("POST /mcp only"));

app.get("/health", (_, res) => res.json({
  status: "ok",
  server: "meta-ads-mcp",
  version: "2.8.0-Final",
  account: ACCOUNT ? `act_${ACCOUNT}` : "NOT SET",
  token: TOKEN ? "configured" : "NOT SET",
  api: API
}));

app.listen(PORT, () => {
  console.log(`Meta Ads MCP Server v2.8.0-Final running on port ${PORT}`);
  if (!TOKEN)   console.error("MISSING: META_ADS_ACCESS_TOKEN");
  if (!ACCOUNT) console.error("MISSING: META_AD_ACCOUNT_ID");
});
