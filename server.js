// ===== ENV & CORE =====
require("dotenv").config();
const express = require("express");
const compression = require("compression");
const crypto = require('crypto');
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const fetch = require("node-fetch"); // v2 for CommonJS

const app = express();
// gzip compression for faster responses
app.use(compression());
app.set("trust proxy", 1);

// simple in-memory TTL cache
const _cache = new Map();
function setCache(key, value, ttlMs = 10 * 60 * 1000) { _cache.set(key, { value, exp: Date.now() + ttlMs }); }
function getCache(key) { const hit = _cache.get(key); if (!hit) return null; if (Date.now() > hit.exp) { _cache.delete(key); return null; } return hit.value; }

// ===== RAW BODY FOR WEBHOOKS =====
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ===== SUPABASE INVENTORY =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---- Angle detection helpers ----
const ANGLES = ["front","back","left","right"];
const FRONTLIKE = /(front|main|default|cover)/i;
const BACKLIKE  = /(back)/i;
const LEFTLIKE  = /(left|side-left|leftside)/i;
const RIGHTLIKE = /(right|side-right|rightside)/i;

function detectAngle(file){
  const pos = (file?.options?.placement || file?.position || file?.type || "").toString().toLowerCase();
  const title = (file?.title || file?.filename || "").toString().toLowerCase();
  const hay = `${pos} ${title}`;
  if (BACKLIKE.test(hay)) return 'back';
  if (LEFTLIKE.test(hay)) return 'left';
  if (RIGHTLIKE.test(hay)) return 'right';
  if (FRONTLIKE.test(hay)) return 'front';
  return 'front';
}

// Generate missing mockups for a product using Printful Mockup Generator
async function generateMissingMockups(productId, variantIds, existingFiles, productName = '') {
  try {
    if (!process.env.PRINTFUL_API_KEY || !variantIds?.length) return {};
    
    // Use the first existing file as the design for all angles
    const designFile = existingFiles.find(f => f.preview_url || f.thumbnail_url);
    if (!designFile) return {};
    
    const imageUrl = designFile.preview_url || designFile.thumbnail_url;
    
    // Determine character type based on product name
    const nameLower = String(productName || '').toLowerCase();
    let optionGroups = ['Flat', 'Men\'s']; // Default to male character
    
    if (nameLower.includes('lake hair don\'t care') || nameLower.includes('lake hair dont care')) {
      // Female character for Lake Hair Don't Care
      optionGroups = ['Flat', 'Women\'s'];
      console.log(`🎭 Using female character for: ${productName}`);
    } else {
      console.log(`🎭 Using male character for: ${productName}`);
    }
    
    // Create mockup generation task for all angles
    const taskPayload = {
      variant_ids: variantIds.slice(0, 6), // Limit to avoid rate limits
      format: 'jpg',
      width: 800,
      files: [{
        placement: 'front',
        image_url: imageUrl
      }],
      options: ['Front', 'Back', 'Left', 'Right'],
      option_groups: optionGroups
    };
    
    console.log(`🎨 Mockup task payload:`, JSON.stringify(taskPayload, null, 2));
    
    const taskResp = await pfFetch(`/mockup-generator/create-task/${productId}`, {
      method: 'POST',
      body: JSON.stringify(taskPayload)
    });
    
    console.log(`📋 Task response:`, taskResp);
    
    const taskKey = taskResp?.result?.task_key;
    if (!taskKey) {
      console.log(`❌ No task key received:`, taskResp);
      return {};
    }
    
    console.log(`🔑 Task key: ${taskKey}`);
    
    // Wait for generation (with timeout)
    let attempts = 0;
    const maxAttempts = 12; // 60 seconds max
    
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
      attempts++;
      
      console.log(`⏰ Attempt ${attempts}/${maxAttempts}: Checking task status...`);
      
      const resultResp = await pfFetch(`/mockup-generator/task?task_key=${taskKey}`, {
        method: 'GET'
      });
      
      console.log(`📊 Task status response:`, resultResp?.result?.status, resultResp?.result?.error || '');
      
      if (resultResp?.result?.status === 'completed') {
        const mockups = resultResp.result.mockups || [];
        const angleMap = {};
        
        // Group mockups by angle
        for (const mockup of mockups) {
          const placement = String(mockup.placement || 'front').toLowerCase();
          const angle = placement.includes('back') ? 'back' : 
                       placement.includes('left') ? 'left' :
                       placement.includes('right') ? 'right' : 'front';
          
          if (!angleMap[angle]) angleMap[angle] = [];
          angleMap[angle].push(mockup.mockup_url);
        }
        
        return angleMap;
      }
      
      if (resultResp?.result?.status === 'failed') {
        console.warn('❌ Mockup generation failed:', resultResp.result.error);
        break;
      }
    }
    
    return {};
  } catch (e) {
    console.warn('Mockup generation error:', e.message);
    return {};
  }
}

function buildGalleryByColor({ variants, files, overrides, defaultColor }){
  const byColor = new Map();
  // seed from variants
  for (const v of variants || []){
    const color = (v.color || v.color_code || v.name || '').toString().toLowerCase().split('/')[0].trim();
    if (!color) continue;
    if (!byColor.has(color)) byColor.set(color, {});
  }
  // attach files to angles, infer color from title/filename mention
  for (const f of files || []){
    const angle = detectAngle(f);
    const url = f.preview_url || f.thumbnail_url || f.url;
    if (!url) continue;
    const raw = (f.title || f.filename || '').toLowerCase();
    let targetColor = (defaultColor || '').toLowerCase();
    for (const c of byColor.keys()){
      if (raw.includes(c)) { targetColor = c; break; }
    }
    if (!targetColor) continue;
    const bucket = byColor.get(targetColor) || {};
    if (!bucket[angle]) bucket[angle] = url;
    byColor.set(targetColor, bucket);
  }
  // admin overrides
  const ov = overrides || {};
  if (ov.custom_mockups && typeof ov.custom_mockups === 'object'){
    for (const [color, angles] of Object.entries(ov.custom_mockups)){
      const key = String(color||'').toLowerCase();
      if (!byColor.has(key)) byColor.set(key, {});
      const bucket = byColor.get(key);
      for (const a of ANGLES){ if (angles[a]) bucket[a] = angles[a]; }
      byColor.set(key, bucket);
    }
  }
  if (ov.hidden_mockups && typeof ov.hidden_mockups === 'object'){
    for (const [color, list] of Object.entries(ov.hidden_mockups)){
      const key = String(color||'').toLowerCase();
      if (!byColor.has(key)) continue;
      const bucket = byColor.get(key);
      for (const a of (Array.isArray(list)? list : [])){
        if (bucket[a]) delete bucket[a];
      }
      byColor.set(key, bucket);
    }
  }
  // fill from default
  const def = defaultColor ? (byColor.get(String(defaultColor).toLowerCase()) || {}) : {};
  for (const [color, bucket] of byColor.entries()){
    for (const a of ANGLES){ if (!bucket[a] && def[a]) bucket[a] = def[a]; }
    byColor.set(color, bucket);
  }
  // images dedupe
  const imagesSet = new Set();
  for (const b of byColor.values()) for (const a of ANGLES) if (b[a]) imagesSet.add(b[a]);
  const galleryByColor = {};
  for (const [color, bucket] of byColor.entries()){
    galleryByColor[color] = { ...bucket, views: { front: bucket.front, back: bucket.back, left: bucket.left, right: bucket.right }, images: Array.from(new Set(Object.values(bucket).filter(Boolean))) };
  }
  return { galleryByColor, images: Array.from(imagesSet) };
}
let inventory = {};

async function loadInventory() {
  const { data, error } = await supabase
    .from("inventory")
    .select("color, quantity");
  if (error) {
    console.error('❌ Failed to load inventory:', error.message);
    throw error;
  }
  if (!data) {
    console.warn('⚠️ No inventory data returned from Supabase');
    return {};
  }
  
  const inv = {};
  data.forEach((i) => (inv[i.color.trim()] = i.quantity));
  console.log('📦 Loaded inventory:', inv);
  return inv;
}

async function updateQuantity(color, qty) {
  const { error } = await supabase
    .from("inventory")
    .update({ quantity: qty })
    .eq("color", color);
  if (error) throw error;
}

loadInventory().then((inv) => {
  inventory = inv;
  console.log('🚀 Server startup - inventory loaded:', inv);
}).catch(err => {
  console.error('❌ Failed to load inventory on startup:', err.message);
  inventory = {};
});

// ===== EMAIL SETUP =====
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Donation bounds
const DON_MIN = parseInt(process.env.DONATION_MIN_CENTS || '100', 10);
const DON_MAX = parseInt(process.env.DONATION_MAX_CENTS || '1000000', 10);

// Test promo (cart) discount helpers
const TEST_MIN_CHARGE_CENTS = parseInt(process.env.TEST_MIN_CHARGE_CENTS || '50', 10);

// ---- Promo ENV parsing ----
// Percent codes: code1..code5 in the format (NAME)PERCENT, e.g. (TAKE5)5
function readPercentPromosFromEnv(env = process.env) {
  const out = [];
  for (let i = 1; i <= 5; i++) {
    const k = `code${i}`;
    const raw = env[k] ?? env[k?.toUpperCase?.()];
    if (!raw) continue;
    const m = String(raw).match(/\(([^)]+)\)\s*(\d{1,3})/);
    if (!m) continue;
    const code = m[1].trim();
    const percent = Math.min(100, Math.max(0, parseInt(m[2], 10) || 0));
    if (!code || percent <= 0) continue;
    out.push({ code, percent });
  }
  return [...new Map(out.map(p => [p.code.toLowerCase(), p])).values()];
}

// Special flat-50 override: FLAT50_CODE="(take5)0" (or any name; percent ignored)
function readFlat50Override(env = process.env) {
  const raw = env.FLAT50_CODE ?? env["flat50_code"];
  if (!raw) return null;
  const m = String(raw).match(/\(([^)]+)\)\s*0/);
  if (!m) return null;
  const code = m[1].trim();
  if (!code) return null;
  return { code };
}

function isFlat50For(codeRaw) {
  if (!codeRaw) return false;
  const flat = readFlat50Override();
  return !!(flat && flat.code.toLowerCase() === String(codeRaw).trim().toLowerCase());
}

// --- ONE-DOLLAR override: TAKE5 -> $1 total, free shipping, no tax ---
function isOneDollarCode(codeRaw) {
  const c = String(codeRaw || "").trim().toLowerCase();
  return c === "take5";
}

// Legacy wrapper for backward compatibility
function readPromoCodesFromEnv(env = process.env) {
  return readPercentPromosFromEnv(env);
}

// Legacy PROMO_MAP - now unused, replaced by readPromoCodesFromEnv() calls
let PROMO_MAP = {};
function getActivePromo(req){ return req.session?.promo || null; }
function setActivePromo(req, promo){ if (!req.session) req.session = {}; req.session.promo = promo; }
function clearActivePromo(req){ if (req.session) req.session.promo = null; }

function calcFlatShipping(lines){ return Array.isArray(lines) && lines.length ? 599 : 0; }
function calcCartTotals(lines, promo){
  const safe = Array.isArray(lines) ? lines : [];
  const subCents = safe.reduce((s,l)=> s + (Number(l.priceCents||0) * Math.max(1, Number(l.qty||1))), 0);
  let discountCents = 0;
  if (promo && promo.percent){ discountCents = Math.floor(subCents * (promo.percent/100)); }
  const shippingCents = calcFlatShipping(safe);
  const totalCents = Math.max(0, subCents - discountCents) + shippingCents;
  return { subCents, discountCents, shippingCents, totalCents };
}
function priceAfterPromo(cents, promoPercent){
  if (!promoPercent) return cents;
  const kept = Math.max(0, 100 - Number(promoPercent));
  return Math.max(0, Math.round((Number(cents) * kept) / 100));
}

// Removed duplicate - using readPromoCodesFromEnv() above

// ===== Idempotency & order-record helpers =====
async function markStripeEventProcessedOnce(eventId, type) {
  // Temporarily bypass idempotency check until Supabase tables are created
  console.log(`Processing Stripe event ${eventId} (${type}) - idempotency temporarily disabled`);
  return true;
}

async function getOrderByExternalId(externalId) {
  // Temporarily bypass order lookup until Supabase tables are created
  console.log(`Would lookup order: ${externalId}`);
  return null; // always treat as new order
}

async function upsertOrderRecord(record) {
  // Temporarily bypass order tracking until Supabase tables are created
  console.log(`Would track order: ${record.external_id} -> ${record.pf_order_id} (${record.status})`);
}

async function findOrderByPIorCharge({ pi, charge }) {
  if (charge) {
    const { data, error } = await supabase
      .from("printful_orders").select("*").eq("charge_id", charge).maybeSingle();
    if (data) return data;
  }
  if (pi) {
    const { data, error } = await supabase
      .from("printful_orders").select("*").eq("pi_id", pi).maybeSingle();
    if (data) return data;
  }
  return null;
}

async function cancelOrderRecord({ external_id, pf_order_id, refund_status }) {
  const payload = {
    external_id,
    pf_order_id,
    status: "canceled",
    refund_status: refund_status || "refunded_or_failed",
    cancelled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("printful_orders")
    .upsert(payload, { onConflict: "external_id" });
  if (error) console.error("cancelOrderRecord error:", error);
}

function opsEmailSubject(external_id, suffix) {
  return `[CatfishEmpire] Printful order ${external_id}: ${suffix}`;
}

async function notifyOps(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Catfish Empire" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html
    });
  } catch (e) {
    console.error("notifyOps failed:", e?.message || e);
  }
}

// === Printful helpers for create + confirm ===
const PF_BASE = "https://api.printful.com";

// Exponential backoff for 429/5xx with jitter
async function pfFetch(path, opts = {}, tries = 5, baseDelay = 400) {
  const storeId = process.env.PRINTFUL_STORE_ID;
  const url = path.includes("?") ? `${PF_BASE}${path}&store_id=${storeId}` : `${PF_BASE}${path}?store_id=${storeId}`;
  const headers = {
    Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`,
    "Content-Type": "application/json",
    ...(opts.headers || {})
  };

  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await fetch(url, { ...opts, headers });
    let json = {};
    try { json = await res.json(); } catch {}

    if (res.ok) return json;

    const status = res.status;
    const msg = json?.error?.message || json?.error || res.statusText;

    // Retry on rate limit / transient errors
    if ((status === 429 || (status >= 500 && status < 600)) && attempt < tries) {
      const jitter = Math.floor(Math.random() * 150);
      const delay = Math.min(4000, baseDelay * Math.pow(2, attempt - 1)) + jitter;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const err = new Error(`Printful ${path} ${status}: ${msg}`);
    err.status = status;
    err.body = json;
    throw err;
  }

  throw new Error("Printful request failed after retries");
}

async function printfulCreateOrderDraft(payload) {
  return pfFetch(`/orders`, { method: "POST", body: JSON.stringify({ ...payload, confirm: false }) });
}

// Helper that creates a Printful order CONFIRMED immediately
async function printfulCreateOrderConfirmed(payload) {
  return pfFetch(`/orders`, { method: "POST", body: JSON.stringify({ ...payload, confirm: true }) });
}

async function printfulConfirmOrder(orderId, { maxTries = 6, delayMs = 1500 } = {}) {
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await pfFetch(`/orders/${orderId}/confirm`, { method: "POST" });
    } catch (err) {
      const status = err.status || 0;
      const msg = (err.body?.error?.message || "").toLowerCase();
      const calc = msg.includes("cost") || msg.includes("calculating") || msg.includes("calculate");
      const already = msg.includes("already confirmed") || msg.includes("status pending") || msg.includes("pending");
      if (already) return { result: { id: orderId, status: "pending" } };
      if (calc && attempt < maxTries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Printful confirm failed after retries");
}

async function printfulGetOrder(orderId) {
  return pfFetch(`/orders/${orderId}`, { method: "GET" });
}

async function printfulCancelOrder(orderId) {
  return pfFetch(`/orders/${orderId}/cancel`, { method: "POST" });
}

// ===== Stripe → Printful recipient mapper =====
function parseJSONSafe(s){ try { return JSON.parse(s); } catch { return null; } }
function stripeToPrintfulRecipient(session){
  const cd = session?.customer_details || {};
  const addr = cd.address || session?.shipping_details?.address || {};
  const name = cd.name || session?.shipping_details?.name || '';
  const email = cd.email || session?.customer_email || '';
  const phone = cd.phone || '';
  const out = {
    name: name || 'Customer',
    address1: addr.line1 || addr.address1 || '',
    address2: addr.line2 || addr.address2 || '',
    city: addr.city || '',
    state_code: addr.state || addr.state_code || '',
    country_code: addr.country || '',
    zip: addr.postal_code || addr.zip || '',
    email: email || 'noreply@example.com',
    phone: phone || ''
  };
  if (!out.address1 || !out.city || !out.state_code || !out.country_code || !out.zip){
    const test = parseJSONSafe(process.env.PRINTFUL_TEST_RECIPIENT || '');
    if (test){
      return {
        name: test.name || out.name,
        address1: test.address1 || out.address1,
        address2: test.address2 || out.address2,
        city: test.city || out.city,
        state_code: test.state_code || out.state_code,
        country_code: test.country_code || out.country_code,
        zip: test.zip || out.zip,
        email: test.email || out.email,
        phone: test.phone || out.phone,
      };
    }
  }
  return out;
}

// ===== Robust variant recovery helpers =====
function titleCase(s){ return (s||'').toString().replace(/\b\w/g,c=>c.toUpperCase()); }
const SIZE_LIST = ['XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
function parseColorSize(variant){
  const explicitColor = variant.color || variant.product_color || null;
  const explicitSize  = variant.size  || variant.product_size  || null;
  if (explicitColor || explicitSize) return { color: explicitColor||'', size: explicitSize||'' };
  const name = String(variant.name||'');
  const tokens = name.split(/[\/-]/).map(t=>t.trim());
  let sizeToken = '';
  let colorToken = '';
  for (const t of tokens){ if (SIZE_LIST.includes(t.toUpperCase())) { sizeToken = t; break; } }
  if (sizeToken){ const other = tokens.find(t=>t!==sizeToken) || ''; colorToken = other; }
  else { colorToken = tokens[0] || ''; }
  return { color: colorToken, size: sizeToken };
}

async function fetchProductVariantsForLookup(productId, token, storeId){
  const base = `https://api.printful.com/store/products/${encodeURIComponent(productId)}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'Catfish Empire Server' };
  let r = await fetch(base, { headers });
  let text = await r.text(); let j; try{ j = JSON.parse(text); } catch { j = { raw:text }; }
  if (!r.ok && /store_id/i.test(JSON.stringify(j)) && storeId){
    r = await fetch(`${base}?store_id=${encodeURIComponent(storeId)}`, { headers });
    text = await r.text(); try{ j = JSON.parse(text); } catch { j = { raw:text }; }
  }
  if (!r.ok) throw new Error(`variant lookup ${r.status}`);
  const sv = j?.result?.sync_variants || [];
  const matrix = {};
  for (const v of sv){
    const { color, size } = parseColorSize(v);
    const key = `${String(color||'').toLowerCase()}|${String(size||'').toLowerCase()}`;
    if (v.id) matrix[key] = Number(v.id);
  }
  return { variants: sv, matrix };
}

async function recoverVariantId(item, token, storeId){
  const direct = Number(item.vid || item.variantId || item.variant_id || 0);
  if (direct) return direct;
  if (!item.pid || !item.c || !item.s) return null;
  const { variants, matrix } = await fetchProductVariantsForLookup(item.pid, token, storeId);
  const key = `${String(item.c).toLowerCase()}|${String(item.s).toLowerCase()}`;
  if (matrix[key]) return Number(matrix[key]);
  const found = variants.find(v=>{ const cs = parseColorSize(v); return String(cs.color).toLowerCase()===String(item.c).toLowerCase() && String(cs.size).toLowerCase()===String(item.s).toLowerCase(); });
  return found ? Number(found.id) : null;
}

async function buildPrintfulItems(decodedItems, token, storeId){
  const out = [];
  for (const i of decodedItems){
    if ((i.t || i.type) !== 'printful') continue;
    const qty = Math.max(1, Number(i.q||i.qty||1));
    const pid = i.pid || i.productId || i.id;
    const color = i.c || i.color; const size = i.s || i.size;
    const vid = await recoverVariantId({ vid:i.vid||i.variantId||i.variant_id, pid, c:color, s:size }, token, storeId);
    if (vid) out.push({ sync_variant_id: Number(vid), quantity: qty });
  }
  return out;
}

// ====== Compact cart item metadata (avoid 500 char limits) ======
// pack a single item into a tiny pipe-delimited string: t|pid|vid|q|c|s
function packItem(it) {
  const t = it.type === 'printful' ? 'p' : 's';
  const pid = it.productId ?? it.product_id ?? '';
  const vid = it.variantId ?? it.variant_id ?? '';
  const q = it.qty ?? 1;
  const c = String(it.color || '').replace(/\|/g,'').toLowerCase();
  const s = String(it.size  || '').replace(/\|/g,'').toUpperCase();
  return [t, pid, vid, q, c, s].join('|');
}

// unpack items from a session's metadata (new keys i0..iN, or legacy JSON)
function unpackSessionItems(session) {
  const md = session?.metadata || {};
  const keys = Object.keys(md).filter(k => /^i\d+$/.test(k)).sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)));
  if (keys.length) {
    return keys.map(k => {
      const [t,pid,vid,q,c,s] = String(md[k]).split('|');
      return {
        type: t === 'p' ? 'printful' : 'sunglasses',
        productId: pid ? Number(pid) : null,
        variantId: vid ? Number(vid) : null,
        qty: q ? Number(q) : 1,
        color: c || null,
        size: s || null
      };
    });
  }
  if (md.items) {
    try { return JSON.parse(md.items); } catch { /* ignore */ }
  }
  return [];
}

// ===== PRINTFUL ORDER ENV FLAGS & LAST ORDER LOG =====
// PRINTFUL_AUTO_FULFILL: if true and PRINTFUL_CONFIRM true, we attempt to confirm order
// PRINTFUL_CONFIRM: if true and auto-fulfill true, order will be confirmed; otherwise draft
// PRINTFUL_LOG_ORDERS: default true; controls console logging of order results
const PRINTFUL_AUTO_FULFILL = String(process.env.PRINTFUL_AUTO_FULFILL || 'false').toLowerCase() === 'true';
const PRINTFUL_CONFIRM = String(process.env.PRINTFUL_CONFIRM || 'false').toLowerCase() === 'true';
const PRINTFUL_LOG_ORDERS = String(process.env.PRINTFUL_LOG_ORDERS || 'true').toLowerCase() !== 'false';

let LAST_PF_ORDER = { request: null, response: null, error: null, ts: 0 };

// Build Printful order items from cart items that are already coerced/validated
async function buildPrintfulOrderItems(cartItems) {
  const out = [];
  for (const it of (cartItems || [])) {
    if (it.type !== 'printful') continue;
    // Ensure we have sync variant id; coercePrintfulCartItem should have provided it
    let variantId = it.variantId || it.variant_id || null;
    let qty = Math.max(1, Number(it.quantity || it.qty || 1));
    let priceCents = Number.isFinite(it.priceCents) ? Number(it.priceCents) : null;

    // If still missing, try resolve again
    if (!variantId && it.productId && (it.color || it.size)) {
      try {
        const resolved = await resolveVariantByProductColorSize(it.productId, it.color, it.size);
        if (resolved?.variantId) variantId = resolved.variantId;
        if (!priceCents && resolved?.priceCents) priceCents = resolved.priceCents;
      } catch {}
    }
    if (!variantId) continue; // skip unsafely

    const item = { sync_variant_id: Number(variantId), quantity: qty };
    if (Number.isFinite(priceCents) && priceCents > 0) {
      item.retail_price = (priceCents / 100).toFixed(2);
    }
    out.push(item);
  }
  return out;
}

// Create Printful order (draft or confirm) from Stripe session + items
async function createPrintfulOrder({ session, items, confirm }) {
  try {
    function stripeToPrintfulRecipient(sess) {
      const cd = sess.customer_details || {};
      const ship = sess.shipping_details || {};
      const addr = (ship && ship.address) || (cd && cd.address) || (sess.payment_intent?.shipping?.address) || null;
      const fallback = process.env.PRINTFUL_TEST_RECIPIENT ? JSON.parse(process.env.PRINTFUL_TEST_RECIPIENT) : null;
      const get = (o,k) => (o && o[k]) || undefined;
      const rec = {
        name: get(ship, 'name') || cd.name || get(fallback, 'name'),
        address1: get(addr, 'line1') || get(fallback, 'address1'),
        address2: get(addr, 'line2') || get(fallback, 'address2') || '',
        city: get(addr, 'city') || get(fallback, 'city'),
        state_code: get(addr, 'state') || get(fallback, 'state_code'),
        country_code: get(addr, 'country') || get(fallback, 'country_code') || 'US',
        zip: get(addr, 'postal_code') || get(fallback, 'zip'),
        email: cd.email || get(fallback, 'email'),
        phone: get(ship, 'phone') || cd.phone || get(fallback, 'phone')
      };
      Object.keys(rec).forEach(k => rec[k] === undefined && delete rec[k]);
      return rec;
    }

    const recipient = stripeToPrintfulRecipient(session);

    const pfItems = await buildPrintfulOrderItems(items);
    const external_id = String(session.id || `sess_${Date.now()}`);
    const body = { external_id, recipient, items: pfItems.map(x => ({ sync_variant_id: x.sync_variant_id, quantity: x.quantity, ...(x.retail_price ? { retail_price: x.retail_price } : {}) })), confirm: !!confirm };

    const token = getPrintfulAuthHeader().replace(/^Bearer\s+/i, '');
    const resp = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    try { globalThis.__LAST_PF_PAYLOAD__ = { when: Date.now(), body: body }; } catch(_){ }
    try { globalThis.__LAST_PF_RESPONSE__ = { status: resp.status, text }; } catch(_){ }
    console.log('PRINTFUL ORDER RESPONSE', resp.status, text);
    LAST_PF_ORDER = { request: body, response: parsed, error: null, ts: Date.now() };
    if (PRINTFUL_LOG_ORDERS) console.log(`PF ORDER CREATED status=${resp.status} external_id=${external_id} confirm=${!!confirm}`);
    if (!resp.ok) throw new Error(`Printful error ${resp.status}: ${text}`);
    return parsed;
  } catch (e) {
    LAST_PF_ORDER = { request: LAST_PF_ORDER.request, response: LAST_PF_ORDER.response, error: String(e.message||e), ts: Date.now() };
    if (PRINTFUL_LOG_ORDERS) console.error(`PF ORDER ERROR status=unknown body=${LAST_PF_ORDER.error}`);
    throw e;
  }
}

// ===== SUPABASE STORAGE HELPERS (mockups) =====
function normColor(c){ return String(c||'').trim().toLowerCase(); }
function validView(v){ const s = String(v||'').toLowerCase(); return ['front','back','left','right'].includes(s) ? s : null; }
function normUrl(u){ return String(u||'').replace(/^http:\/\//i,'https://'); }
function uniqBy(arr, keyFn){ const m=new Map(); for(const it of (arr||[])){ const k=keyFn(it); if(!k) continue; if(!m.has(k)) m.set(k,it);} return Array.from(m.values()); }
function uniq(arr){ return Array.from(new Set(arr||[])); }
function safeUrl(u){ return String(u||'').replace(/^http:\/\//i,'https://'); }

// ===== Supabase Storage helpers for persistent mockups =====
const supaAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function ensureBucketPublic(bucket = "mockups") {
  try {
    await supaAdmin.storage.createBucket(bucket, { public: true });
  } catch (e) {
    const msg = (e?.message || "").toLowerCase();
    if (!msg.includes("already exists")) console.warn("createBucket warn:", e?.message || e);
  }
  return bucket;
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function guessContentType(url) {
  const u = url.split("?")[0].toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

async function uploadMockupAndGetPublicUrl({ bucket = "mockups", productId, color, angle, sourceUrl }) {
  await ensureBucketPublic(bucket);
  const ct = guessContentType(sourceUrl);
  const buf = await fetchBuffer(sourceUrl);
  const safeColor = String(color).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const path = `${productId}/${safeColor}/${angle}${ct === "image/png" ? ".png" : ct === "image/webp" ? ".webp" : ".jpg"}`;
  const { error: upErr } = await supaAdmin.storage.from(bucket).upload(path, buf, { contentType: ct, upsert: true });
  if (upErr) throw upErr;
  const { data: pub } = supaAdmin.storage.from(bucket).getPublicUrl(path);
  return pub.publicUrl;
}

async function mergeCustomMockupsInDB(productId, mapByColor) {
  let current = null;
  try {
    const { data } = await supabase.from("product_overrides").select("*").eq("product_id", productId).maybeSingle();
    current = data || { product_id: productId };
  } catch (e) { console.warn("fetch overrides error:", e?.message || e); }

  const next = current?.custom_mockups || {};
  for (const [color, angles] of Object.entries(mapByColor)) {
    next[color] = { ...(next[color] || {}), ...angles };
  }

  const payload = { product_id: productId, custom_mockups: next };
  const { error } = await supabase.from("product_overrides").upsert(payload, { onConflict: "product_id" });
  if (error) throw error;
  return next;
}

function parseColorSizeFromVariant(v){
  const SIZE_LIST = ['XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
  const explicitColor = (v.color || v.product_color || '').trim();
  const explicitSize  = (v.size  || v.product_size  || '').trim();
  if (explicitColor || explicitSize) return { color: explicitColor, size: explicitSize };
  const parts = String(v.name||'').split(/[\/\-]/).map(s=>s.trim());
  const size = parts.find(p=>SIZE_LIST.includes(p.toUpperCase())) || '';
  const color = parts.find(p=>p !== size) || '';
  return { color, size };
}

// === Build color-aware gallery from variant files; map to angles before dedupe ===
function buildGalleryByColor(syncVariants){
  const byColor = {};
  for (const v of (syncVariants||[])){
    const { color } = parseColorSizeFromVariant(v);
    const key = (color||'').toLowerCase().trim();
    if (!key) continue;
    if (!byColor[key]) byColor[key] = [];
    for (const f of (v.files || [])){
      byColor[key].push({ type: String(f.type||'').toLowerCase(), url: safeUrl(f.preview_url || f.thumbnail_url || '') });
    }
  }

  const out = {};
  for (const [colorKey, files] of Object.entries(byColor)){
    const views = { front:null, back:null, left:null, right:null };
    for (const f of files){
      const t = f.type, u = f.url; if (!u) continue;
      if (!views.front && (t==='front' || t==='default' || t==='preview')) views.front = u;
      if (!views.back  && t==='back') views.back = u;
      if (!views.left  && (t==='sleeve_left' || t==='left')) views.left = u;
      if (!views.right && (t==='sleeve_right'|| t==='right')) views.right = u;
    }
    const seen = new Set();
    const gallery = [];
    for (const f of files){ const u=f.url; if (!u || seen.has(u)) continue; seen.add(u); gallery.push(u); }
    const cover = views.front || views.back || views.left || views.right || gallery[0] || null;
    out[colorKey] = { color: colorKey, views, images: gallery, cover };
  }
  return out;
}
async function uploadMockupToSupabase({ productId, color, view, filename, contentType, buffer }) {
  await ensureBucketPublic('mockups');
  const safeView = (view || 'other').toLowerCase();
  const path = `printful/${String(productId)}/${String(color).toLowerCase()}/${safeView}/${filename}`;
  const { error } = await supaAdmin.storage.from('mockups').upload(path, buffer, { contentType: contentType || 'image/webp', upsert: true });
  if (error) throw error;
  const { data: pub } = supaAdmin.storage.from('mockups').getPublicUrl(path);
  return { url: pub.publicUrl, path };
}

// ===== ZIP INGEST: Parse hoodie mockups from a ZIP URL and persist angles =====
function detectAngleFromName(name) {
  const s = String(name||'').toLowerCase();
  if (s.includes('back')) return 'back';
  if (s.includes('left-front') || s.includes('left_front') || s.includes('front-left')) return 'left';
  if (s.includes('right-front') || s.includes('right_front') || s.includes('front-right')) return 'right';
  if (s.includes('left') && !s.includes('front')) return 'left';
  if (s.includes('right') && !s.includes('front')) return 'right';
  if (s.includes('front') || s.includes('preview') || s.includes('default')) return 'front';
  return null;
}
function detectColorFromPath(name) {
  const s = String(name||'').toLowerCase();
  const COLORS = ['black','white','red','blue','navy','dark heather','sport grey','charcoal','heather','maroon','military green','forest','green','royal','purple','sand','ash','graphite','carbon'];
  // Try folder segments first
  const parts = s.split(/[\\/]+/);
  for (const p of parts) {
    const hit = COLORS.find(c => p.includes(c));
    if (hit) return hit;
  }
  const hit = COLORS.find(c => s.includes(c));
  return hit || null;
}

app.post('/admin/mockups/ingest-zip', cors(), express.json({ limit: '25mb' }), async (req, res) => {
  try {
    // Temporarily allow without auth for speed during dev
    // if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const productId = String(req.body?.productId||'').trim();
    const zipUrl = String(req.body?.zipUrl||'').trim();
    const zipBase64 = req.body?.zipBase64 ? String(req.body.zipBase64) : null;
    if (!productId || (!zipUrl && !zipBase64)) return res.status(400).json({ error: 'productId and zipUrl|zipBase64 required' });

    // Download or decode zip
    let zipBuffer;
    if (zipBase64) {
      const b64 = zipBase64.includes(',') ? zipBase64.split(',').pop() : zipBase64;
      zipBuffer = Buffer.from(b64, 'base64');
    } else {
      const r = await fetch(zipUrl);
      if (!r.ok) return res.status(400).json({ error: `zip download failed ${r.status}` });
      zipBuffer = await r.buffer();
    }

    // Lazy-load adm-zip without declaring types
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    const persisted = {}; // color -> { front, back, left, right }
    let savedCount = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      const name = e.entryName || e.name || '';
      const lower = String(name).toLowerCase();
      if (!/(\.png|\.jpg|\.jpeg|\.webp)$/i.test(lower)) continue;
      const angle = detectAngleFromName(lower);
      const color = detectColorFromPath(lower);
      if (!angle || !color) continue;
      const buffer = e.getData();
      const filename = name.split(/[\\/]+/).pop();
      const contentType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.jpg')||lower.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
      const saved = await uploadMockupToSupabase({ productId, color, view: angle, filename, contentType, buffer });
      const ck = String(color).toLowerCase();
      if (!persisted[ck]) persisted[ck] = {};
      persisted[ck][angle] = saved.url;
      savedCount++;
    }

    if (savedCount === 0) return res.status(400).json({ error: 'No images matched color/angle patterns in zip' });

    // Merge to product_overrides.custom_mockups
    const merged = await mergeCustomMockupsInDB(productId, persisted);
    return res.json({ ok: true, saved: savedCount, productId, custom_mockups: merged });
  } catch (e) {
    console.error('ingest-zip failed:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Helper: ingest a ZIP from GitHub (frontend repo) and persist angles, returning map for immediate merge
let __ingestLocks = new Set();
async function ingestZipFromRepoAndPersist({ productId, zipPathInRepo }) {
  const lockKey = `${productId}|${zipPathInRepo}`;
  if (__ingestLocks.has(lockKey)) return null;
  __ingestLocks.add(lockKey);
  try {
    const rawUrl = `https://raw.githubusercontent.com/RICHMEDIAEMPIRE/catfish-empire/main/${encodeURIComponent(zipPathInRepo).replace(/%2F/g,'/')}`;
    const r = await fetch(rawUrl);
    if (!r.ok) throw new Error(`zip download failed ${r.status}`);
    const zipBuffer = await r.buffer();
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    const persisted = {}; // color -> { front, back, left, right }
    let savedCount = 0;
    for (const e of entries) {
      if (e.isDirectory) continue;
      const name = e.entryName || e.name || '';
      const lower = String(name).toLowerCase();
      if (!/(\.png|\.jpg|\.jpeg|\.webp)$/i.test(lower)) continue;
      const angle = detectAngleFromName(lower);
      const color = detectColorFromPath(lower);
      if (!angle || !color) continue;
      const buffer = e.getData();
      const filename = name.split(/[\\/]+/).pop();
      const contentType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.jpg')||lower.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
      const saved = await uploadMockupToSupabase({ productId, color, view: angle, filename, contentType, buffer });
      const ck = String(color).toLowerCase();
      if (!persisted[ck]) persisted[ck] = {};
      persisted[ck][angle] = saved.url;
      savedCount++;
    }
    if (savedCount > 0) {
      await mergeCustomMockupsInDB(productId, persisted);
      return persisted;
    }
    return null;
  } catch (e) {
    console.warn('ingestZipFromRepoAndPersist failed:', e?.message || e);
    return null;
  } finally {
    __ingestLocks.delete(lockKey);
  }
}

async function removeMockupFromSupabase(path) {
  const { error } = await supabase.storage.from('mockups').remove([path]);
  if (error) throw error;
}

// Global hidden image URLs (explicit suppressions)
const GLOBAL_HIDDEN_URLS = new Set([
  'https://files.cdn.printful.com/files/913/913bbbe9ca436bd693757d21dce528c2_preview.png',
  'https://files.cdn.printful.com/files/b87/b87af5e750905c48adce2f19a3096443_preview.png',
  'https://files.cdn.printful.com/files/f63/f6377c84da44db6dc356547e9066da18_preview.png'
]);
function isGloballyHidden(u) { return GLOBAL_HIDDEN_URLS.has(String(u || '').trim()); }

// ===== SESSION & CORS =====
const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://www.catfishempire.com',
  'https://catfishempire.com',
  'https://test1243.netlify.app'
].filter(Boolean);

const corsAllow = cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }, 
  credentials: true 
});
app.use(corsAllow);
// Manually echo allowed origin for credentialed requests to avoid wildcard
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "changeme",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, sameSite: "none" },
  })
);

// ===== HEALTH =====
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// Serve static assets from /public (also mount at root)
try {
  const path = require('path');
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { maxAge: '1h' }));
  app.use('/public', express.static(publicDir, { maxAge: '1h' }));
} catch(_) {}


// =====================================================================
// ====================== PRINTFUL API INTEGRATION ====================
// =====================================================================

// Helper functions for Printful API calls
function pfHeaders() {
  const token = printfulAccessToken || process.env.PRINTFUL_API_KEY || '';
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'CatfishEmpireServer'
  };
}

function withStoreId(baseUrl) {
  const storeId = process.env.PRINTFUL_STORE_ID;
  if (!storeId) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}store_id=${encodeURIComponent(storeId)}`;
}

// Centralized Printful POST with optional store_id and logging
async function pfPost(path, body) {
  const base = 'https://api.printful.com';
  const storeId = process.env.PRINTFUL_STORE_ID && String(process.env.PRINTFUL_STORE_ID).trim();
  const url = storeId ? `${base}${path}?store_id=${encodeURIComponent(storeId)}` : `${base}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: getPrintfulAuthHeader(),
      'Content-Type': 'application/json',
      'User-Agent': 'Catfish Empire Server'
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text };
}

if (!global.__pfDebug) global.__pfDebug = { lastPayload:null, lastResponse:null };
app.get('/admin/debug/printful-last', cors(), (_req, res) => res.json(global.__pfDebug));

// ===================== DEBUG HELPERS (Printful) =====================
// Ping Printful with auth header to verify token/permissions quickly
app.get('/api/debug/ping-printful', cors(), async (req, res) => {
  try {
    const r = await fetch('https://api.printful.com/stores', {
      headers: {
        Authorization: getPrintfulAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish-Debug/1.0'
      }
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    res.status(r.status).json({ ok: r.ok, status: r.status, body: json });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get the raw Printful store product (with store_id retry) + a compact summary
app.get('/api/debug/product/:id', cors(), async (req, res) => {
  const id = String(req.params.id).trim();
  try {
    const token = process.env.PRINTFUL_API_KEY;
    if (!token) return res.status(500).json({ error: 'PRINTFUL_API_KEY missing' });

    const baseUrl = `https://api.printful.com/store/products/${encodeURIComponent(id)}`;
    const doFetch = async (url) => {
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Catfish-Debug/1.0'
        }
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { r, j };
    };

    // try without store_id
    let { r, j } = await doFetch(baseUrl);
    if (!r.ok && /store_id/i.test(JSON.stringify(j))) {
      const sid = process.env.PRINTFUL_STORE_ID || await getPrintfulStoreId().catch(() => null);
      if (!sid) return res.status(400).json({ error: 'Printful requires store_id and none is configured.' });
      ({ r, j } = await doFetch(`${baseUrl}?store_id=${encodeURIComponent(sid)}`));
    }
    if (!r.ok) return res.status(r.status).json({ error: 'Printful product fetch failed', details: j });

    const d = j?.result || {};
    const sp = d.sync_product || {};
    const sv = Array.isArray(d.sync_variants) ? d.sync_variants : [];

    const SIZE_LIST = ['XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
    const parseCS = (v) => {
      const color = v.color || v.product_color || '';
      const size = v.size || v.product_size || '';
      if (color || size) return { color, size };
      const parts = String(v.name||'').split(/[\/\-]/).map(s => s.trim());
      const sizeTok = parts.find(p => SIZE_LIST.includes(p.toUpperCase())) || '';
      const colorTok = parts.find(p => p !== sizeTok) || '';
      return { color: colorTok, size: sizeTok };
    };

    const byColor = {};
    for (const v of sv) {
      const { color, size } = parseCS(v);
      const cKey = (color||'').toLowerCase();
      if (!byColor[cKey]) byColor[cKey] = { count: 0, sizes: new Set(), files: [] };
      byColor[cKey].count++;
      if (size) byColor[cKey].sizes.add(size);
      (v.files || []).forEach(f => {
        byColor[cKey].files.push({
          type: f.type || null,
          preview_url: f.preview_url || null,
          thumbnail_url: f.thumbnail_url || null
        });
      });
    }
    Object.values(byColor).forEach(x => x.sizes = Array.from(x.sizes));

    res.json({
      ok: true,
      product: { id: d.id || sp.id, name: sp.name || d.name, thumbnail: sp.thumbnail_url || null },
      variants: sv.length,
      summaryByColor: byColor,
      raw: j
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Optional: simple view of image urls by color (front/back/left/right if detectable)
app.get('/api/debug/mockups/:id', cors(), async (req, res) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/api/debug/product/${encodeURIComponent(req.params.id)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true, fromVariants: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// =================== END DEBUG HELPERS (Printful) ====================

// ====================== PRINTFUL OAUTH (Bearer) =====================
// In-memory token storage (replace with persistent storage later)
let printfulAccessToken = null;
let printfulTokenInfo = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  scope: null
};

function setPrintfulToken(tokenResponse) {
  printfulAccessToken = tokenResponse.access_token;
  printfulTokenInfo = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: tokenResponse.expires_in ? Date.now() + (tokenResponse.expires_in * 1000) : 0,
    scope: tokenResponse.scope || null
  };
  console.log("🔐 Stored Printful access token in memory. Expires at:", printfulTokenInfo.expires_at || 'unknown');
}

function getPrintfulAuthHeader() {
  // Prefer OAuth token if available, otherwise fall back to env token if set
  const token = printfulAccessToken || process.env.PRINTFUL_API_KEY || '';
  return `Bearer ${token}`;
}

// Deterministic external_id for Printful (max 32 chars, alphanumeric + dash/underscore only)
function mkPfExternalId(stripeSessionId) {
  const hash = crypto.createHash('sha1').update(String(stripeSessionId||''))
    .digest('hex').slice(0,24); // 24 hex chars
  return `ce${hash}`; // 26 total chars, no special chars except what's allowed
}

// Fetch details for a specific Printful store variant (name, price, image, color, size)
async function fetchPrintfulVariantDetails(variantId) {
  if (!variantId) throw new Error('Missing Printful variantId');
  
  const url = withStoreId(`https://api.printful.com/store/variants/${encodeURIComponent(variantId)}`);
  const resp = await fetch(url, { headers: pfHeaders() });
  
  if (!resp.ok) {
    throw new Error(`Variant fetch failed ${resp.status}`);
  }
  
  const data = await resp.json();
  const sv = data?.result?.sync_variant || data?.result || {};
  const files = sv.files || [];
  const file = files.find(f => f.preview_url) || files[0] || {};
  const image_url = file.preview_url || file.thumbnail_url || '';
  const name = sv.name || 'Printful Variant';
  const price = parseFloat(sv.retail_price || sv.price || '0') || 0;
  const parsed = String(name).split('/').map(s => s.trim());
  const color = sv.color || sv.product_color || (parsed.length >= 2 ? parsed[0] : '');
  const size = sv.size || sv.product_size || (parsed.length >= 2 ? parsed[1] : '');
  return { id: Number(variantId), name, price, image_url, color, size };
}

// Resolve a Printful variant and price from productId + color + size
async function resolveVariantByProductColorSize(productId, color, size) {
  try {
    const token = process.env.PRINTFUL_API_KEY;
    const detail = await getPrintfulProductDetailCached(productId, token);
    const d = detail?.result || {};
    const svs = Array.isArray(d.sync_variants) ? d.sync_variants : (d.variants || []);
    const wantedColor = String(color || '').toLowerCase();
    const wantedSize = String(size || '').toLowerCase();
    const SIZE_LIST = ['xs','s','m','l','xl','2xl','3xl','4xl','5xl'];
    let chosen = null;
    for (const v of svs) {
      const vColor = String(v.color || v.product_color || '').toLowerCase();
      const vSize  = String(v.size  || v.product_size  || '').toLowerCase();
      const name = String(v.name || '');
      const tokens = name.split(/[\/-]/).map(t => t.trim().toLowerCase());
      const parsedSize = vSize || tokens.find(t => SIZE_LIST.includes(t)) || '';
      const parsedColor = vColor || tokens.find(t => t !== parsedSize) || '';
      if (parsedColor === wantedColor && parsedSize === wantedSize) { chosen = v; break; }
    }
    if (!chosen) return { variantId: null, priceCents: null, image: null };
    const cents = Math.round(parseFloat(chosen.retail_price || chosen.price || '0') * 100) || 0;
    const file = (chosen.files || []).find(f => f.preview_url) || {};
    return { variantId: chosen.id, priceCents: cents, image: file.preview_url || null };
  } catch (e) {
    return { variantId: null, priceCents: null, image: null };
  }
}

// Sanitize a client printful item to safe server representation
async function coercePrintfulCartItem(item) {
  let variantId = item.variantId || item.variant_id || null;
  let priceCents = Number.isFinite(item?.priceCents) ? Number(item.priceCents) : null;
  let imageUrl = item.image || null;
  if ((!variantId || !priceCents) && item.productId && (item.color||item.size)) {
    const resolved = await resolveVariantByProductColorSize(item.productId, item.color, item.size);
    if (resolved?.variantId) variantId = resolved.variantId;
    if (resolved?.priceCents) priceCents = resolved.priceCents;
    if (!imageUrl && resolved?.image) imageUrl = resolved.image;
  }
  if (variantId && (!priceCents || priceCents <= 0)) {
    try {
      const v = await fetchPrintfulVariantDetails(variantId);
      priceCents = Math.round((v.price || 0) * 100);
      if (!imageUrl && v.image_url) imageUrl = v.image_url;
    } catch {}
  }
  if (!variantId || !priceCents || priceCents <= 0) throw new Error('Missing Printful variantId or priceCents');
  return {
    name: item.name || 'Catfish Empire Product',
    variantId,
    priceCents,
    currency: (item.currency || 'USD').toLowerCase(),
    quantity: Number(item.qty || 1),
    imageUrl,
    productId: item.productId,
    color: item.color || null,
    size: item.size || null,
  };
}

// Create a Printful draft order (non-blocking)
async function createPrintfulDraftOrder(recipient, pfItems) {
  try {
    const storeId = process.env.PRINTFUL_STORE_ID;
    const url = storeId ? `https://api.printful.com/orders?store_id=${encodeURIComponent(storeId)}` : `https://api.printful.com/orders`;
    const body = {
      recipient: {
        name: recipient.name,
        address1: recipient.line1,
        address2: recipient.line2 || '',
        city: recipient.city,
        state_code: recipient.state,
        country_code: recipient.country || 'US',
        zip: recipient.postal_code,
        email: recipient.email || undefined
      },
      items: pfItems.map(it => ({ quantity: it.quantity, variant_id: it.variantId, name: it.name })),
      confirm: false
    };
    const resp = await fetch(url, { method: 'POST', headers: { Authorization: getPrintfulAuthHeader(), 'Content-Type': 'application/json', 'User-Agent': 'Catfish Empire Server' }, body: JSON.stringify(body) });
    const json = await resp.json().catch(()=>({}));
    if (!resp.ok) { console.error('Printful order create failed:', resp.status, json); return { ok:false, json }; }
    console.log('✅ Printful draft order created:', json?.result?.id || json);
    return { ok:true, json };
  } catch (e) {
    console.error('Printful draft order error:', e.message);
    return { ok:false, error:e.message };
  }
}

// GET /auth/printful/login → redirect user to Printful OAuth consent
app.get('/auth/printful/login', (req, res) => {
  try {
    const clientId = process.env.PRINTFUL_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: 'PRINTFUL_CLIENT_ID is not configured' });
    }

    const redirectUri = process.env.PRINTFUL_REDIRECT_URI || `https://catfish-stripe-backend.onrender.com/auth/printful/callback`;

    const authUrl = new URL('https://www.printful.com/oauth/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    // Optional: scopes managed in Printful app; omit for default

    console.log('➡️ Redirecting to Printful OAuth:', authUrl.toString());
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('❌ Error building Printful OAuth URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /auth/printful/callback → exchange code for access token
app.get('/auth/printful/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: 'Missing code parameter' });
    }

    const clientId = process.env.PRINTFUL_CLIENT_ID;
    const clientSecret = process.env.PRINTFUL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'PRINTFUL_CLIENT_ID/PRINTFUL_CLIENT_SECRET not configured' });
    }

    const redirectUri = process.env.PRINTFUL_REDIRECT_URI || `https://catfish-stripe-backend.onrender.com/auth/printful/callback`;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString();

    const tokenResp = await fetch('https://api.printful.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Catfish Empire Server'
      },
      body
    });

    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error('❌ Printful token exchange failed:', tokenResp.status, tokenJson);
      return res.status(500).json({ error: 'Token exchange failed', details: tokenJson });
    }

    setPrintfulToken(tokenJson);
    res.status(200).json({ success: true, token_received: !!printfulAccessToken, expires_at: printfulTokenInfo.expires_at });
  } catch (error) {
    console.error('❌ Callback error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Simple test route to verify bearer token works
app.get('/test-printful', async (req, res) => {
  try {
    const response = await fetch('https://api.printful.com/store/products', {
      method: 'GET',
      headers: {
        Authorization: getPrintfulAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });
    const json = await response.json();
    res.status(response.status).json(json);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Global cache for store_id
let cachedStoreId = null;

// Clear cached store ID (useful for debugging or error recovery)
const clearStoreIdCache = () => {
  console.log("🗑️ Clearing cached store ID");
  cachedStoreId = null;
};

// Get Printful store ID - prefer env var, then cached, then fetch
const getPrintfulStoreId = async () => {
  // First priority: environment variable
  if (process.env.PRINTFUL_STORE_ID) {
    console.log(`✅ Using PRINTFUL_STORE_ID from env: ${process.env.PRINTFUL_STORE_ID}`);
    return process.env.PRINTFUL_STORE_ID;
  }

  // Second priority: cached value
  if (cachedStoreId) {
    console.log(`🎯 Using cached store ID: ${cachedStoreId}`);
    return cachedStoreId;
  }

  console.log("🔍 Fetching store information (trying /stores)...");
  
  try {
    // Try the multi-store listing endpoint
    const listResp = await fetch('https://api.printful.com/stores', {
      method: 'GET',
      headers: pfHeaders()
    });
    const listJson = await listResp.json().catch(() => ({}));
    if (listResp.ok && Array.isArray(listJson.result) && listJson.result.length > 0) {
      cachedStoreId = listJson.result[0].id;
      console.log(`✅ Cached store ID from /stores: ${cachedStoreId}`);
      return cachedStoreId;
    }

    throw new Error('No store_id available. Set PRINTFUL_STORE_ID or use a token scoped to a default store.');
    
  } catch (error) {
    console.error("❌ Error fetching store ID:", error.message);
    cachedStoreId = null;
    throw new Error(`Unable to retrieve store ID: ${error.message}`);
  }
};



// GET /api/printful-products → fast cached list for homepage
app.get("/api/printful-products", cors(), async (req, res) => {
  try {
    const key = "pf:list:v2";
    const cached = getCache(key);
    if (cached) {
      res.set("Cache-Control", "public, max-age=300"); // 5 min client cache
      return res.json(cached);
    }

    const token = process.env.PRINTFUL_API_KEY;
    if (!token) return res.status(500).json({ error: 'Printful token missing' });

    // Fast list fetch - no per-product detail calls
    const baseListUrl = withStoreId('https://api.printful.com/store/products');
    const listResp = await fetch(baseListUrl, { headers: pfHeaders() });
    const listJson = await listResp.json().catch(() => ({}));
    const products = Array.isArray(listJson.result) ? listJson.result : [];
    
    // Simple card list - just basic info for fast homepage load
    const cards = products.map(p => ({
      id: p.id,
      name: p.name || 'Product',
      thumb: p.thumbnail_url || '',
      image: p.thumbnail_url || '',
      priceMinCents: null, // Will be loaded on-demand
      currency: 'USD',
      hasVariants: true
    }));

    // Apply Supabase sort if available
    try {
      const ids = cards.map(c => String(c.id));
      const { data: sorts } = await supabase
        .from('product_sort')
        .select('product_id, sort_index');
      if (Array.isArray(sorts) && sorts.length) {
        const sortMap = new Map(sorts.map(r => [String(r.product_id), Number(r.sort_index) || 0]));
        cards.sort((a,b) => (sortMap.get(String(a.id)) ?? 1e9) - (sortMap.get(String(b.id)) ?? 1e9));
      }
    } catch {}

    const payload = { products: cards, count: cards.length };
    setCache(key, payload, 5 * 60 * 1000); // 5 min server cache
    res.set("Cache-Control", "public, max-age=300");
    return res.json(payload);
  } catch (error) {
    console.error('❌ /api/printful-products error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function getPrintfulProductDetailCached(id, token) {
  const TTL = 15 * 60 * 1000;
  if (!global.pfCache) global.pfCache = { productsList: { data: null, ts: 0 }, productDetailById: {}, variantById: {} };
  const entry = global.pfCache.productDetailById[id];
  if (entry && Date.now() - entry.ts < TTL) return entry.data;
  
  const url = withStoreId(`https://api.printful.com/store/products/${encodeURIComponent(id)}`);
  const r = await fetch(url, { headers: pfHeaders() });
  
  if (!r.ok) throw new Error(`detail ${r.status}`);
  
  const j = await r.json();
  global.pfCache.productDetailById[id] = { data: j, ts: Date.now() };
  return j;
}

// GET /api/printful/variant/:variantId → returns { id, priceCents, currency, color, size, name, image } from cached detail
app.get('/api/printful/variant/:variantId', cors(), async (req, res) => {
  try {
    const bypass = ("nocache" in req.query);
    const variantId = String(req.params.variantId);
    const TTL = 15 * 60 * 1000;
    if (!global.pfCache) global.pfCache = { productsList: { data: null, ts: 0 }, productDetailById: {}, variantById: {} };
    
    const cached = global.pfCache.variantById[variantId];
    if (!bypass && cached && Date.now() - cached.ts < TTL) return res.json(cached.data);
    
    // Fallback to withStoreId if not in cache
    const url = withStoreId(`https://api.printful.com/store/variants/${encodeURIComponent(variantId)}`);
    const r = await fetch(url, { headers: pfHeaders() });
    
    if (!r.ok) {
      return res.status(r.status).json({ error: 'Variant fetch failed' });
    }
    
    const result = await r.json();
    const sv = result?.result?.sync_variant || result?.result || {};
    const files = sv.files || [];
    const file = files.find(f => f.preview_url) || files[0] || {};
    
    const data = { 
      id: Number(variantId), 
      priceCents: Math.round((parseFloat(sv.retail_price || sv.price || '0')) * 100), 
      currency: 'USD', 
      color: sv.color || sv.product_color || null, 
      size: sv.size || sv.product_size || null, 
      name: sv.name || 'Printful Variant', 
      image: file.preview_url || file.thumbnail_url || null 
    };
    
    if (!bypass) global.pfCache.variantById[variantId] = { data, ts: Date.now() };
    res.json(data);
      } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Printful Catalog variant cache (color/size metadata)
async function getCatalogVariant(variantId) {
  const TTL = 60 * 60 * 1000;
  if (!global.pfCache) global.pfCache = { productsList: { data: null, ts: 0 }, productDetailById: {}, variantById: {}, catalogVariantById: {} };
  if (!global.pfCache.catalogVariantById) global.pfCache.catalogVariantById = {};
  const key = String(variantId);
  const cached = global.pfCache.catalogVariantById[key];
  if (cached && Date.now() - cached.ts < TTL) return cached.data;
  const token = process.env.PRINTFUL_API_KEY;
  const base = `https://api.printful.com/products/variant/${encodeURIComponent(variantId)}`;
  const resp = await fetch(base, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'Catfish-Empire/1.0' } });
  const json = await resp.json().catch(()=>({}));
  if (!resp.ok || json.code !== 200) throw new Error(`catalog variant ${variantId} failed ${resp.status}`);
  global.pfCache.catalogVariantById[key] = { data: json.result, ts: Date.now() };
  return json.result;
}

// GET /api/printful-product/:id → detail { id, name, description, images[], options:{colors[],sizes[]}, variants:[{id,color,size,priceCents,image}], variantMatrix{'color|size':variantId} }
// Color normalizer for consistent key matching
function colorKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\//g, " ")       // split combos like "Black/Black"
    .replace(/\s+/g, " ")      // collapse spaces
    .trim();                   // keep readable, but stable
}

app.get('/api/printful-product/:id', cors(), async (req, res) => {
  try {
    const prodId = String(req.params.id).trim();
    if (!prodId) return res.status(400).json({ error: 'Missing product id' });

    const token = process.env.PRINTFUL_API_KEY;
    if (!token) return res.status(500).json({ error: 'Printful token missing' });

    const bypass = ("nocache" in req.query);

    // Fetch product details using withStoreId helper
    const url = withStoreId(`https://api.printful.com/store/products/${encodeURIComponent(prodId)}`);
    const r = await fetch(url, { headers: pfHeaders() });
    
    if (!r.ok) {
      return res.status(r.status).json({ error: 'Printful product fetch failed' });
    }

    const result = await r.json();
    const d = result?.result || {};
    const sp = d.sync_product || {};
    const svs = Array.isArray(d.sync_variants) ? d.sync_variants : (d.variants || []);

    // --- Build images, grouped by color & view ---
    function viewFromUrl(u='') {
      const s = String(u).toLowerCase();
      if (s.includes('back')) return 'back';
      if (s.includes('left-front') || s.includes('left_front') || s.includes('front-left') || s.includes('frontleft') || s.includes('leftfront')) return 'left-front';
      if (s.includes('right-front') || s.includes('right_front') || s.includes('front-right') || s.includes('frontright') || s.includes('rightfront')) return 'right-front';
      if (s.includes('sleeve_left') || s.includes('left-side') || s.includes('left_side') || s.includes('leftprofile') || s.includes('profile-left')) return 'left';
      if (s.includes('sleeve_right') || s.includes('right-side') || s.includes('right_side') || s.includes('rightprofile') || s.includes('profile-right')) return 'right';
      if (s.includes('front') || s.includes('default') || s.includes('preview')) return 'front';
      return 'other';
    }
    const isDesign = (u='') => {
      const s = String(u).toLowerCase();
      return s.includes('printfile') || s.includes('design');
    };
    const isHidden = (u, hiddenSet) => hiddenSet && hiddenSet.has(String(u));
    const globalImagesSet = new Set();
    const mockupsByColor = {};
    const coverByColor = {};
    let galleryByColor = {}; // colorLower -> { views: {front,back,left,right}, images: [] }
    const viewOrder = ['front','back','left-front','right-front','left','right','other'];
    if (Array.isArray(sp.files)) {
      sp.files.forEach(f => { const u=normUrl(f?.preview_url); if (u && !isDesign(u) && !isGloballyHidden(u)) globalImagesSet.add(u); });
    }
    for (const v of svs) {
      const { color } = parseColorSize(v);
      const colorKey = (color || '').toLowerCase();
      const files = Array.isArray(v.files) ? v.files : [];
      for (const f of files) {
        const url = normUrl(f?.preview_url);
        if (!url || isDesign(url) || isGloballyHidden(url)) continue;
        const view = viewFromUrl(url);
        const ftype = String(f?.type||'').toLowerCase();
        globalImagesSet.add(url);
        if (!mockupsByColor[colorKey]) mockupsByColor[colorKey] = [];
        if (!mockupsByColor[colorKey].some(m => m.url === url)) { mockupsByColor[colorKey].push({ url, view, type: ftype }); }
      }
    }
    Object.keys(mockupsByColor).forEach(colorKey => {
      mockupsByColor[colorKey].sort((a,b) => viewOrder.indexOf(a.view) - viewOrder.indexOf(b.view));
      const front = mockupsByColor[colorKey].find(m => m.view === 'front');
      coverByColor[colorKey] = (front?.url) || (mockupsByColor[colorKey][0]?.url) || null;
      const views = {};
      for (const m of mockupsByColor[colorKey]) {
        const t = String(m.type||'');
        if (!views.front && (m.view==='front' || t==='front' || t==='default' || t==='preview')) views.front = m.url;
        if (!views.back && (m.view==='back' || t==='back')) views.back = m.url;
        if (!views.left && (m.view==='left' || t==='sleeve_left' || t==='left-front')) views.left = m.url;
        if (!views.right && (m.view==='right' || t==='sleeve_right' || t==='right-front')) views.right = m.url;
      }
      const imagesList = uniqBy(mockupsByColor[colorKey].map(m => m.url), u=>u).map(u=>u);
      galleryByColor[colorKey] = { views: views, images: imagesList };
    });
    let images = Array.from(globalImagesSet);

    // Helpers for parsing color/size
    const SIZE_LIST = ['XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
    function titleCase(s){ return (s||'').toString().replace(/\b\w/g,c=>c.toUpperCase()); }
    function parseColorSize(v){
      const explicitColor = v.color || v.product_color || null;
      const explicitSize = v.size || v.product_size || null;
      if (explicitColor || explicitSize) return { color: explicitColor||'', size: explicitSize||'' };
      const name = String(v.name||'');
      const tokens = name.split(/[\/-]/).map(t=>t.trim());
      let sizeToken = '';
      let colorToken = '';
      for (const t of tokens){
        if (SIZE_LIST.includes(t.toUpperCase())) { sizeToken = t; break; }
      }
      if (sizeToken){
        const other = tokens.find(t=>t!==sizeToken) || '';
        colorToken = other;
      } else {
        colorToken = tokens[0]||'';
      }
      return { color: colorToken, size: sizeToken };
    }

    // Build variants, options, and matrix - exclude variants with missing price
    const variants = [];
    let colors = [];
    const sizes = [];
    let variantMatrix = {};
    let priceByKey = {};
    let count = 0;
    
    for (const v of svs) {
      const cents = Math.round(parseFloat(v.retail_price || v.price || '0') * 100);
      if (!isFinite(cents) || cents <= 0) continue; // exclude variants with missing/zero price
      
      const { color, size } = parseColorSize(v);
      const rawColor = (color||'');
      const rawSize = (size||'');
      const file = (v.files || []).find(f => f.preview_url) || {};
      
      const entry = {
        id: v.id,
        name: v.name || `${titleCase(rawColor)} / ${titleCase(rawSize)}`,
        color: rawColor || null,
        size: rawSize || null,
        priceCents: cents,
        currency: 'USD',
        image: file.preview_url || null
      };
      variants.push(entry);
      
      const key = `${(rawColor||'').toLowerCase()}|${(rawSize||'').toLowerCase()}`;
      variantMatrix[key] = v.id;
      priceByKey[key] = cents;
      
      if (rawColor && !colors.includes(rawColor)) colors.push(rawColor);
      if (rawSize && !sizes.includes(rawSize)) sizes.push(rawSize);
      count++;
    }
    
    // Sort colors and sizes for consistent ordering
    colors.sort();
    sizes.sort();
    
    // Apply per-product overrides from Supabase (if table exists)
    try {
      const { data: overrideRows } = await supabase
        .from('product_overrides')
        .select('*, custom_by_color')
        .eq('product_id', String(d.id || sp.id || prodId))
        .limit(1);
      const override = Array.isArray(overrideRows) ? overrideRows[0] : null;
      if (override) {
        const hiddenAll = new Set();
        // jsonb structure: custom_mockups { colorLower: { views, images } }, hidden_mockups { colorLower: [urls] }
        if (override.custom_mockups && typeof override.custom_mockups === 'object') {
          // Mama Tribe: alias 'heather' -> 'dark heather' to match Printful color naming
          if (String(prodId) === '393216161') {
            try {
              const cm = override.custom_mockups;
              if (cm['heather'] && !cm['dark heather']) {
                cm['dark heather'] = cm['heather'];
              }
            } catch(_) {}
          }
          for (const colorKey of Object.keys(override.custom_mockups)) {
            const oc = override.custom_mockups[colorKey] || {};
            const dst = galleryByColor[colorKey] || { views:{}, images:[] };
            if (oc.views) {
              for (const vKey of Object.keys(oc.views)) {
                if (oc.views[vKey]) dst.views[vKey] = oc.views[vKey];
              }
            }
            if (Array.isArray(oc.images)) {
              const set = new Set(dst.images);
              oc.images.forEach(u => { if (u) set.add(u); });
              dst.images = Array.from(set);
            }
            galleryByColor[colorKey] = dst;
          }
        }
        // Hidden mockups can be either an object { color:[urls] } or a flat array of urls
        if (Array.isArray(override.hidden_mockups)) {
          const hidAll = new Set((override.hidden_mockups || []).map(String));
          hidAll.forEach(u => hiddenAll.add(String(u)));
          for (const colorKey of Object.keys(galleryByColor)) {
            const g = galleryByColor[colorKey];
            g.images = (g.images||[]).filter(u => !hidAll.has(String(u)));
            const views = g.views || {};
            for (const vKey of Object.keys(views)) {
              if (hidAll.has(String(views[vKey]))) views[vKey] = null;
            }
            g.views = views;
            galleryByColor[colorKey] = g;
          }
        } else if (override.hidden_mockups && typeof override.hidden_mockups === 'object') {
          for (const colorKey of Object.keys(override.hidden_mockups)) {
            const hid = new Set((override.hidden_mockups[colorKey] || []).map(String));
            hid.forEach(u => hiddenAll.add(String(u)));
            if (galleryByColor[colorKey]) {
              galleryByColor[colorKey].images = (galleryByColor[colorKey].images||[]).filter(u => !hid.has(u));
              for (const vKey of Object.keys(galleryByColor[colorKey].views||{})) {
                if (hid.has(String(galleryByColor[colorKey].views[vKey]))) galleryByColor[colorKey].views[vKey] = null;
              }
            }
          }
        }

        // Also filter top-level images fallback by any hidden URLs
        if (hiddenAll.size) {
          images = (images || []).filter(u => !hiddenAll.has(String(u)));
        }
        // Merge color-aware overrides (includes persistent mockups from Supabase Storage)
        if (override.custom_by_color && typeof override.custom_by_color === 'object') {
          const byColor = override.custom_by_color;
          for (const [colorKey, val] of Object.entries(byColor)) {
            const ck = normColor(colorKey);
            if (!galleryByColor[ck]) {
              galleryByColor[ck] = { images: [], views: { front:[], back:[], left:[], right:[] } };
            }
            const dst = galleryByColor[ck];
            const addAll = (arr, into) => (arr||[]).forEach(u => { if (u && !into.includes(u)) into.push(u); });
            addAll(val?.images, dst.images);
            const v = val?.views || {};
            addAll(v.front, dst.views.front);
            addAll(v.back,  dst.views.back);
            addAll(v.left,  dst.views.left);
            addAll(v.right, dst.views.right);
          }
        }
        
        // NEW: hard-merge persisted custom mockups (from Storage) so they take priority
        if (override.custom_mockups && typeof override.custom_mockups === 'object') {
          for (const [color, angles] of Object.entries(override.custom_mockups)) {
            const lc = color.toLowerCase();
            if (!galleryByColor[lc]) galleryByColor[lc] = { views: {}, images: [] };
            for (const a of ["front","back","left","right"]) {
              if (angles[a]) {
                galleryByColor[lc].views[a] = angles[a];
                if (!galleryByColor[lc].images.includes(angles[a])) {
                  galleryByColor[lc].images.push(angles[a]);
                }
              }
            }
          }
        }
        if (override.title_override) {
          sp.name = override.title_override;
        }
        if (override.description_override) {
          sp.description = override.description_override;
        }
        // price_override_cents could be applied to display in UI if needed
      }
  } catch (e) {
      // Likely table missing; ignore silently
      console.warn('product_overrides not applied:', e.message);
    }

    // PRODUCT-SPECIFIC COLOR FILTERS
    // Mama Tribe™ Graphic Tee: only show colors selected at creation time
    if (String(prodId) === '393216161') {
      const allowed = ['ash','black','charcoal','dark heather','light pink','sand','white'];
      const allowSet = new Set(allowed.map(s => s.toLowerCase()));
      colors = colors.filter(c => allowSet.has(String(c||'').toLowerCase()));
      // Filter variant/price matrices by allowed colors
      const nextMatrix = {}; const nextPrice = {};
      for (const [key, vid] of Object.entries(variantMatrix||{})) {
        const [c] = key.split('|');
        if (allowSet.has(String(c||'').toLowerCase())) { nextMatrix[key] = vid; if (priceByKey[key]!=null) nextPrice[key] = priceByKey[key]; }
      }
      variantMatrix = nextMatrix; priceByKey = nextPrice;
      // Filter gallery buckets
      const nextGallery = {};
      for (const [ck, g] of Object.entries(galleryByColor||{})) {
        if (allowSet.has(String(ck||'').toLowerCase())) nextGallery[ck] = g;
      }
      galleryByColor = nextGallery;
    }

    // Pick defaultColor: ensure we have a valid front image for the default
    let defaultColor = null;
    const colorScores = colors.map(c => {
      const key = String(c||'').toLowerCase();
      const g = galleryByColor[key] || {};
      const views = g.views || {};
      const hasFront = !!views.front;
      const score = (hasFront ? 10 : 0) + ['back','left','right','left-front','right-front']
        .reduce((n,k2)=> n + (views[k2]?1:0), 0);
      return { c, key, hasFront, score };
    });
    colorScores.sort((a,b)=> (b.score - a.score) || String(a.c).localeCompare(String(b.c)) );
    defaultColor = colorScores.find(x => x.hasFront)?.c || (colorScores[0]?.c || colors[0] || null);
    const coverImage = (galleryByColor[String(defaultColor||'').toLowerCase()]?.views?.front)
      || coverByColor[String(defaultColor||'').toLowerCase()] || images[0] || null;

    // Ensure every color has all angles - generate missing ones if needed
    try {
      const allColors = Object.keys(galleryByColor);
      for (const colorKey of allColors) {
        const g = galleryByColor[colorKey];
        const views = g.views || {};
        const missingAngles = [];
        
        for (const angle of ['front','back','left','right']) {
          if (!views[angle]) missingAngles.push(angle);
        }
        
        // If we have some angles but missing others, optionally queue background generation (throttled)
        if (missingAngles.length > 0 && missingAngles.length < 4) {
          const AUTO_GEN = String(process.env.PRINTFUL_AUTO_GEN_MISSING || 'false').toLowerCase() === 'true';
          if (AUTO_GEN) {
            queuedColors = queuedColors || new Set();
            if (!queuedColors.has(colorKey)) queuedColors.add(colorKey);
          }
        }
        
        // No global angle fallbacks: products without explicit angles should only show 'front'
        if (!views.front && Array.isArray(g.images) && g.images.length) {
          views.front = g.images[0];
        }
        g.views = views;
        galleryByColor[colorKey] = g;
      }
      // Process any queued background generations sequentially to avoid 429
      if (typeof queuedColors !== 'undefined' && queuedColors.size) {
        setImmediate(async () => {
          try {
            const productName = (sp?.name || d?.name || '').toString();
            for (const ck of Array.from(queuedColors)) {
              try {
                const vids = (svs || []).filter(v => {
                  const cs = parseColorSize(v);
                  return String(cs.color||'').toLowerCase() === ck;
                }).map(v => v.variant_id || v.id).filter(Boolean);
                if (vids.length) {
                  await generateMissingMockups(prodId, vids, [], productName);
                  await new Promise(r => setTimeout(r, 2000));
                }
              } catch (e) {
                console.warn('Background mockup generation failed:', e?.message || e);
              }
            }
          } catch (e) {
            console.warn('Background mockup generation failed:', e?.message || e);
          }
        });
      }
    } catch(_) {}

    // 0) Build a display map for colors found in variants
    const displayByKey = {};
    for (const v of svs) {
      const { color } = parseColorSize(v);
      const display = (color || '').toString().trim();
      const key = colorKey(display);
      if (key) displayByKey[key] = display;
    }

    // HARDCODED: Distressed Flag Tee (392073769) angles via GitHub raw
    if (String(prodId) === '392073769') {
      try {
        const base = 'https://raw.githubusercontent.com/RICHMEDIAEMPIRE/catfish-empire/main/mockups/distressed-flag-tee';
        const colorsMap = {
          'black': {
            front: `${base}/unisex-basic-softstyle-t-shirt-black-front-68cb1a6c2d7df.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-black-back-68cb1a6c2c67b.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-black-left-68cb1a6c2fd83.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-black-right-68cb1a6c3084b.jpg`,
          },
          'dark chocolate': {
            front: `${base}/unisex-basic-softstyle-t-shirt-dark-chocolate-front-68cb1a6c2d915.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-dark-chocolate-back-68cb1a6c2c891.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-dark-chocolate-left-68cb1a6c2fe34.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-dark-chocolate-right-68cb1a6c308fc.jpg`,
          },
          'dark heather grey': {
            front: `${base}/unisex-basic-softstyle-t-shirt-dark-heather-grey-front-68cb1a6c2e250.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-dark-heather-grey-back-68cb1a6c2d30b.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-dark-heather-grey-left-68cb1a6c3053a.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-dark-heather-grey-right-68cb1a6c30fdb.jpg`,
          },
          'heather navy': {
            front: `${base}/unisex-basic-softstyle-t-shirt-heather-navy-front-68cb1a6c2da0d.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-heather-navy-back-68cb1a6c2c932.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-heather-navy-left-68cb1a6c2fec1.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-heather-navy-right-68cb1a6c30986.jpg`,
          },
          'heather red': {
            front: `${base}/unisex-basic-softstyle-t-shirt-heather-red-front-68cb1a6c2e11e.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-heather-red-back-68cb1a6c2d104.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-heather-red-left-68cb1a6c3042a.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-heather-red-right-68cb1a6c30ecc.jpg`,
          },
          'heliconia': {
            front: `${base}/unisex-basic-softstyle-t-shirt-heliconia-front-68cb1a6c2e2f3.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-heliconia-back-68cb1a6c2d413.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-heliconia-left-68cb1a6c305c4.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-heliconia-right-68cb1a6c31064.jpg`,
          },
          'ice grey': {
            front: `${base}/unisex-basic-softstyle-t-shirt-ice-grey-front-68cb1a6c2e1ae.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-ice-grey-back-68cb1a6c2d203.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-ice-grey-left-68cb1a6c304b4.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-ice-grey-right-68cb1a6c30f54.jpg`,
          },
          'light blue': {
            front: `${base}/unisex-basic-softstyle-t-shirt-light-blue-front-68cb1a6c2dadb.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-light-blue-back-68cb1a6c2c9c5.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-light-blue-left-68cb1a6c2ff4f.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-light-blue-right-68cb1a6c30a14.jpg`,
          },
          'military green': {
            front: `${base}/unisex-basic-softstyle-t-shirt-military-green-front-68cb1a6c2dbd3.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-military-green-back-68cb1a6c2ca59.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-military-green-left-68cb1a6c2ffda.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-military-green-right-68cb1a6c30a9d.jpg`,
          },
          'natural': {
            front: `${base}/unisex-basic-softstyle-t-shirt-natural-front-68cb1a6c2e074.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-natural-back-68cb1a6c2cff8.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-natural-left-68cb1a6c303a3.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-natural-right-68cb1a6c30e47.jpg`,
          },
          'navy': {
            front: `${base}/unisex-basic-softstyle-t-shirt-navy-front-68cb1a6c2dcb0.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-navy-back-68cb1a6c2cae3.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-navy-left-68cb1a6c30061.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-navy-right-68cb1a6c30b25.jpg`,
          },
          'purple': {
            front: `${base}/unisex-basic-softstyle-t-shirt-purple-front-68cb1a6c2dd3d.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-purple-back-68cb1a6c2cb71.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-purple-left-68cb1a6c300e2.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-purple-right-68cb1a6c30ba5.jpg`,
          },
          'red': {
            front: `${base}/unisex-basic-softstyle-t-shirt-red-front-68cb1a6c2ddc4.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-red-back-68cb1a6c2cbf8.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-red-left-68cb1a6c30167.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-red-right-68cb1a6c30c2a.jpg`,
          },
          'sand': {
            front: `${base}/unisex-basic-softstyle-t-shirt-sand-front-68cb1a6c2de4c.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-sand-back-68cb1a6c2ccbf.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-sand-left-68cb1a6c30208.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-sand-right-68cb1a6c30cb0.jpg`,
          },
          'sport grey': {
            front: `${base}/unisex-basic-softstyle-t-shirt-sport-grey-front-68cb1a6c2ded2.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-sport-grey-back-68cb1a6c2cdcf.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-sport-grey-left-68cb1a6c30292.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-sport-grey-right-68cb1a6c30d37.jpg`,
          },
          'white': {
            front: `${base}/unisex-basic-softstyle-t-shirt-white-front-68cb1a6c2df88.jpg`,
            back: `${base}/unisex-basic-softstyle-t-shirt-white-back-68cb1a6c2cedb.jpg`,
            left: `${base}/unisex-basic-softstyle-t-shirt-white-left-68cb1a6c3031c.jpg`,
            right: `${base}/unisex-basic-softstyle-t-shirt-white-right-68cb1a6c30dc1.jpg`,
          },
        };
        for (const [ck, views] of Object.entries(colorsMap)) {
          const key = String(ck).toLowerCase();
          if (!galleryByColor[key]) galleryByColor[key] = { views: {}, images: [] };
          for (const a of ['front','back','left','right']) {
            const url = views[a];
            if (url) {
              galleryByColor[key].views[a] = url;
              if (!galleryByColor[key].images.includes(url)) galleryByColor[key].images.push(url);
            }
          }
        }
      } catch (e) {
        console.warn('flag tee hard-wire merge failed:', e?.message || e);
      }
    }

    // NEW: Hoodie mockups ingestion (392073598) from frontend repo ZIP, then merge
    if (String(prodId) === '392073598') {
      try {
        // Hard-wire GitHub raw URLs for hoodie angles by color
        const base = 'https://raw.githubusercontent.com/RICHMEDIAEMPIRE/catfish-empire/main/mockups/hoodie';
        const hood = (color) => ({
          front: `${base}/unisex-heavy-blend-hoodie-${color}-front-68cb4c5c4f*.jpg`.replace('*',''),
          back: `${base}/unisex-heavy-blend-hoodie-${color}-back-68cb4c5c4f*.jpg`.replace('*',''),
          left: `${base}/unisex-heavy-blend-hoodie-${color}-left-front-68cb4c5c50*.jpg`.replace('*',''),
          right: `${base}/unisex-heavy-blend-hoodie-${color}-right-front-68cb4c5c51*.jpg`.replace('*',''),
        });
        const colorsMap = {
          'black': {
            front: `${base}/unisex-heavy-blend-hoodie-black-front-68cb4c5c4ecf4.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-black-back-68cb4c5c4f94d.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-black-left-front-68cb4c5c503ad.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-black-right-front-68cb4c5c50de3.jpg`,
          },
          'charcoal': {
            front: `${base}/unisex-heavy-blend-hoodie-charcoal-front-68cb4c5c4eedd.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-charcoal-back-68cb4c5c4f9ef.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-charcoal-left-front-68cb4c5c50464.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-charcoal-right-front-68cb4c5c50e96.jpg`,
          },
          'dark chocolate': {
            front: `${base}/unisex-heavy-blend-hoodie-dark-chocolate-front-68cb4c5c4ef7a.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-dark-chocolate-back-68cb4c5c4fa76.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-dark-chocolate-left-front-68cb4c5c504f3.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-dark-chocolate-right-front-68cb4c5c50f24.jpg`,
          },
          'dark heather': {
            front: `${base}/unisex-heavy-blend-hoodie-dark-heather-front-68cb4c5c4f007.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-dark-heather-back-68cb4c5c4faf9.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-dark-heather-left-front-68cb4c5c50581.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-dark-heather-right-front-68cb4c5c50fb5.jpg`,
          },
          'forest green': {
            front: `${base}/unisex-heavy-blend-hoodie-forest-green-front-68cb4c5c4f09d.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-forest-green-back-68cb4c5c4fb7c.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-forest-green-left-front-68cb4c5c5060c.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-forest-green-right-front-68cb4c5c51042.jpg`,
          },
          'graphite heather': {
            front: `${base}/unisex-heavy-blend-hoodie-graphite-heather-front-68cb4c5c4f615.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-graphite-heather-back-68cb4c5c50087.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-graphite-heather-left-front-68cb4c5c50b30.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-graphite-heather-right-front-68cb4c5c51581.jpg`,
          },
          'heliconia': {
            front: `${base}/unisex-heavy-blend-hoodie-heliconia-front-68cb4c5c4f58c.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-heliconia-back-68cb4c5c50007.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-heliconia-left-front-68cb4c5c50aad.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-heliconia-right-front-68cb4c5c514fe.jpg`,
          },
          'irish green': {
            front: `${base}/unisex-heavy-blend-hoodie-irish-green-front-68cb4c5c4f128.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-irish-green-back-68cb4c5c4fbff.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-irish-green-left-front-68cb4c5c50692.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-irish-green-right-front-68cb4c5c510c8.jpg`,
          },
          'light pink': {
            front: `${base}/unisex-heavy-blend-hoodie-light-pink-front-68cb4c5c4f1b2.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-light-pink-back-68cb4c5c4fc8b.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-light-pink-left-front-68cb4c5c50717.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-light-pink-right-front-68cb4c5c5114e.jpg`,
          },
          'maroon': {
            front: `${base}/unisex-heavy-blend-hoodie-maroon-front-68cb4c5c4f23a.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-maroon-back-68cb4c5c4fd0e.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-maroon-left-front-68cb4c5c5079b.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-maroon-right-front-68cb4c5c511d3.jpg`,
          },
          'military green': {
            front: `${base}/unisex-heavy-blend-hoodie-military-green-front-68cb4c5c4f2c9.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-military-green-back-68cb4c5c4fd8d.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-military-green-left-front-68cb4c5c5081b.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-military-green-right-front-68cb4c5c51254.jpg`,
          },
          'navy': {
            front: `${base}/unisex-heavy-blend-hoodie-navy-front-68cb4c5c4f352.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-navy-back-68cb4c5c4fe0d.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-navy-left-front-68cb4c5c508a4.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-navy-right-front-68cb4c5c512d7.jpg`,
          },
          'orange': {
            front: `${base}/unisex-heavy-blend-hoodie-orange-front-68cb4c5c4f6a1.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-orange-back-68cb4c5c50108.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-orange-left-front-68cb4c5c50bb5.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-orange-right-front-68cb4c5c51608.jpg`,
          },
          'royal': {
            front: `${base}/unisex-heavy-blend-hoodie-royal-front-68cb4c5c4f3d7.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-royal-back-68cb4c5c4fe8a.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-royal-left-front-68cb4c5c50926.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-royal-right-front-68cb4c5c51360.jpg`,
          },
          'sand': {
            front: `${base}/unisex-heavy-blend-hoodie-sand-front-68cb4c5c4f468.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-sand-back-68cb4c5c4ff0b.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-sand-left-front-68cb4c5c509aa.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-sand-right-front-68cb4c5c513f6.jpg`,
          },
          'white': {
            front: `${base}/unisex-heavy-blend-hoodie-white-front-68cb4c5c4f504.jpg`,
            back: `${base}/unisex-heavy-blend-hoodie-white-back-68cb4c5c4ff89.jpg`,
            left: `${base}/unisex-heavy-blend-hoodie-white-left-front-68cb4c5c50a2b.jpg`,
            right: `${base}/unisex-heavy-blend-hoodie-white-right-front-68cb4c5c5147b.jpg`,
          },
        };
        for (const [ck, views] of Object.entries(colorsMap)) {
          const key = String(ck).toLowerCase();
          if (!galleryByColor[key]) galleryByColor[key] = { views: {}, images: [] };
          for (const a of ['front','back','left','right']) {
            const url = views[a];
            if (url) {
              galleryByColor[key].views[a] = url;
              if (!galleryByColor[key].images.includes(url)) galleryByColor[key].images.push(url);
            }
          }
        }
      } catch (e) {
        console.warn('hoodie hard-wire merge failed:', e?.message || e);
      }
    }

    // HARDCODED: Mama Tribe Graphic Tee (393216161) angles via GitHub raw
    if (String(prodId) === '393216161') {
      try {
        const base = 'https://raw.githubusercontent.com/RICHMEDIAEMPIRE/catfish-empire/main/mockups/mama%20tribe';
        const colorsMap = {
          'ash': {
            front: `${base}/unisex-classic-tee-ash-front-68cf408bcd4be.png`,
            back: `${base}/unisex-classic-tee-ash-back-68cf408bcdd57.png`,
            left: `${base}/unisex-classic-tee-ash-left-front-68cf408bce3cf.png`,
            right: `${base}/unisex-classic-tee-ash-left-front-68cf408bce3cf.png`,
          },
          'black': {
            front: `${base}/unisex-classic-tee-black-front-68cf408bcd744.png`,
            back: `${base}/unisex-classic-tee-black-back-68cf408bcde13.png`,
            left: `${base}/unisex-classic-tee-black-left-front-68cf408bce487.png`,
            right: `${base}/unisex-classic-tee-black-left-front-68cf408bce487.png`,
          },
          'charcoal': {
            front: `${base}/unisex-classic-tee-charcoal-front-68cf408bcd7e9.png`,
            back: `${base}/unisex-classic-tee-charcoal-back-68cf408bcdea6.png`,
            left: `${base}/unisex-classic-tee-charcoal-left-front-68cf408bce525.png`,
            right: `${base}/unisex-classic-tee-charcoal-left-front-68cf408bce525.png`,
          },
          'dark heather': {
            front: `${base}/unisex-classic-tee-dark-heather-front-68cf408bcd91d.png`,
            back: `${base}/unisex-classic-tee-dark-heather-back-68cf408bcdfc4.png`,
            left: `${base}/unisex-classic-tee-dark-heather-left-front-68cf408bce64c.png`,
            right: `${base}/unisex-classic-tee-dark-heather-left-front-68cf408bce64c.png`,
          },
          'light pink': {
            front: `${base}/unisex-classic-tee-light-pink-front-68cf408bcd9ad.png`,
            back: `${base}/unisex-classic-tee-light-pink-back-68cf408bce052.png`,
            left: `${base}/unisex-classic-tee-light-pink-left-front-68cf408bce6db.png`,
            right: `${base}/unisex-classic-tee-light-pink-left-front-68cf408bce6db.png`,
          },
          'sand': {
            front: `${base}/unisex-classic-tee-sand-front-68cf408bcda3c.png`,
            back: `${base}/unisex-classic-tee-sand-back-68cf408bce0e0.png`,
            left: `${base}/unisex-classic-tee-sand-left-front-68cf408bce772.png`,
            right: `${base}/unisex-classic-tee-sand-left-front-68cf408bce772.png`,
          },
          'white': {
            front: `${base}/unisex-classic-tee-white-front-68cf408bcdac7.png`,
            back: `${base}/unisex-classic-tee-white-back-68cf408bce180.png`,
            left: `${base}/unisex-classic-tee-white-left-front-68cf408bce80e.png`,
            right: `${base}/unisex-classic-tee-white-left-front-68cf408bce80e.png`,
          },
        };
        for (const [ck, views] of Object.entries(colorsMap)) {
          const key = String(ck).toLowerCase();
          if (!galleryByColor[key]) galleryByColor[key] = { views: {}, images: [] };
          for (const a of ['front','back','left','right']) {
            const url = views[a];
            if (url) {
              galleryByColor[key].views[a] = url;
              if (!galleryByColor[key].images.includes(url)) galleryByColor[key].images.push(url);
            }
          }
        }
      } catch (e) {
        console.warn('mama tribe hard-wire merge failed:', e?.message || e);
      }
    }

    // 1) Normalize galleryByColor keys
    const normalizedGallery = {};
    for (const [c, bucket] of Object.entries(galleryByColor || {})) {
      const k = colorKey(c);
      if (!k) continue;
      normalizedGallery[k] = bucket;
    }
    galleryByColor = normalizedGallery;

    // 2) Normalize variantMatrix & priceByKey keys to "<colorKey>|<size>"
    const normalizedVariantMatrix = {};
    const normalizedPriceByKey = {};
    for (const [k, val] of Object.entries(variantMatrix || {})) {
      const [c, s] = k.split("|");
      const nk = `${colorKey(c)}|${(s || "").trim()}`;
      normalizedVariantMatrix[nk] = val;
    }
    for (const [k, val] of Object.entries(priceByKey || {})) {
      const [c, s] = k.split("|");
      const nk = `${colorKey(c)}|${(s || "").trim()}`;
      normalizedPriceByKey[nk] = val;
    }
    variantMatrix = normalizedVariantMatrix;
    priceByKey = normalizedPriceByKey;

    // 3) Default color key normalized
    defaultColor = colorKey(defaultColor) || Object.keys(galleryByColor)[0] || "";

    // 4) availableAnglesByColor and colors array
    const ANGLES = ["front","back","left","right"];
    const availableAnglesByColor = {};
    for (const [c, bucket] of Object.entries(galleryByColor)) {
      availableAnglesByColor[c] = ANGLES.filter(a => !!bucket?.views?.[a]);
    }
    const colorsArray = Object.keys(displayByKey).map(k => ({ key: k, label: displayByKey[k] || k }));

    console.log(`🧩 /api/printful-product/${prodId}: variants=${count}`);

    res.json({
      id: d.id || sp.id || Number(prodId),
      name: sp.name || d.name || 'Printful Product',
      description: sp.description || d.description || null,
      images,
      options: { colors, sizes },
      variants,
      variantMatrix,
      priceByKey,
      galleryByColor,
      defaultColor,
      coverImage,
      colors: colorsArray,                    // NEW
      availableAnglesByColor                  // NEW
    });
      } catch (e) {
    console.error('❌ /api/printful-product error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint to test environment variables (REMOVE IN PRODUCTION)
app.get("/debug/env", cors(), async (req, res) => {
  try {
    const printfulKey = process.env.PRINTFUL_API_KEY;
    const adminPass = process.env.ADMIN_PASSWORD;
    
    res.json({
      printfulApiKey: {
        exists: !!printfulKey,
        length: printfulKey ? printfulKey.length : 0,
        preview: printfulKey ? `${printfulKey.substring(0, 8)}...` : 'Not set',
        note: "Must be OAuth 2.0 Bearer token from https://developers.printful.com/"
      },
      adminPassword: {
        exists: !!adminPass,
        length: adminPass ? adminPass.length : 0
      },
      storeCache: {
        hasCachedId: !!cachedStoreId,
        cachedId: cachedStoreId ? `${cachedStoreId.toString().substring(0, 4)}...` : null
      },
      allEnvKeys: Object.keys(process.env).filter(key => 
        key.includes('PRINTFUL') || key.includes('ADMIN') || key.includes('SUPABASE')
      ),
      message: "Printful uses OAuth 2.0 Bearer tokens with dynamic store ID fetching"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === DEBUG: printful raw files/angles ===
app.get('/debug/printful-raw-product/:id', cors(), async (req, res) => {
  try {
    const id = String(req.params.id).trim();
    const token = process.env.PRINTFUL_API_KEY;
    if (!token) return res.status(500).json({ error: 'Missing PRINTFUL_API_KEY' });

    const baseUrl = `https://api.printful.com/store/products/${encodeURIComponent(id)}`;
    async function fetchWithStoreId(url) {
      let r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Catfish Empire Server' } });
      let t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      if (!r.ok && /store_id/i.test(JSON.stringify(j))) {
        const sid = process.env.PRINTFUL_STORE_ID;
        if (!sid) return { ok: r.ok, status: r.status, data: j };
        const r2 = await fetch(`${url}?store_id=${sid}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Catfish Empire Server' } });
        const t2 = await r2.text(); let j2; try { j2 = JSON.parse(t2); } catch { j2 = { raw: t2 }; }
        return { ok: r2.ok, status: r2.status, data: j2 };
      }
      return { ok: r.ok, status: r.status, data: j };
    }

    const resp = await fetchWithStoreId(baseUrl);
    if (!resp.ok) return res.status(resp.status).json(resp.data);
    const d = resp.data?.result || {};
    const sp = d.sync_product || {};
    const svs = Array.isArray(d.sync_variants) ? d.sync_variants : [];

    function detectView(u=''){
      const s = String(u).toLowerCase();
      if (s.includes('back')) return 'back';
      if (s.includes('left-front')) return 'left-front';
      if (s.includes('right-front')) return 'right-front';
      if (s.includes('left')) return 'left';
      if (s.includes('right')) return 'right';
      if (s.includes('front')) return 'front';
      return 'unknown';
    }

    const productFiles = (sp.files||[]).map(f => ({
      type: f.type, preview_url: f.preview_url, thumb: f.thumbnail_url, view: detectView(f.preview_url||'')
    }));

    const variants = svs.map(v => ({
      id: v.id,
      name: v.name,
      files: (v.files||[]).map(f => ({
        type: f.type, preview_url: f.preview_url, thumb: f.thumbnail_url, view: detectView(f.preview_url||'')
      }))
    }));

    res.json({
      product_id: d.id || sp.id || id,
      product_name: sp.name || d.name,
      product_files: productFiles,
      variants
    });
  } catch (e) {
    console.error('debug raw product error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint to clear store cache (REMOVE IN PRODUCTION)
app.post("/debug/clear-store-cache", cors(), async (req, res) => {
  try {
    clearStoreIdCache();
    res.json({ 
      success: true, 
      message: "Store ID cache cleared successfully" 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// ========================= EXISTING ENDPOINTS =========================
// =====================================================================

// ===== LOGIN =====
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== INVENTORY ENDPOINTS =====
app.get("/public-inventory", async (req, res) => {
  try {
    const inv = await loadInventory();
    inventory = inv;
    res.json(inv);
  } catch (err) {
    res.json(inventory);
  }
});

app.get("/inventory", async (req, res) => {
  if (!req.session.authenticated)
    return res.status(403).json({ error: "Not logged in" });
  const inv = await loadInventory();
  inventory = inv;
  res.json(inv);
});

app.post("/inventory", async (req, res) => {
  if (!req.session.authenticated)
    return res.status(403).json({ error: "Not logged in" });
  const { color, qty } = req.body;
  const qtyInt = parseInt(qty, 10);
  await updateQuantity(color, qtyInt);
  inventory[color] = qtyInt;
  res.json({ success: true });
});

// ===== PROMO: Active promo state =====
app.get('/api/promo/active', cors(), (req, res) => {
  try {
    const promo = getActivePromo(req);
    res.json({ promo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Validate a code and set in session
app.post('/api/promo/apply', corsAllow, express.json(), (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase().replace(/\s+/g,'');
  const flat50 = String(process.env.FLAT50_CODE || '').trim().toLowerCase();
  if (flat50 && code === flat50){
    setActivePromo(req, { code, percent: 0, mode: 'flat50' });
    return res.json({ ok: true, code, percent: 0, mode: 'flat50' });
  }
  const promos = readPromoCodesFromEnv();
  const found = promos.find(p => p.code === code);
  if (!found) return res.status(404).json({ ok: false, message: 'Invalid code' });
  setActivePromo(req, { code: found.code, percent: found.percent });
  res.json({ ok: true, code: found.code, percent: found.percent });
});

// Clear promo
app.post('/api/promo/clear', corsAllow, (_req, res) => {
  clearActivePromo(_req);
  res.json({ ok: true });
});

// Robust validator: parse env codes, case-insensitive, tolerant of spaces (code1..code5)
// DEBUG: confirm server sees env + detection
app.get("/admin/promo/debug", corsAllow, (req, res) => {
  const q = (req.query.code || "").toString();
  const flat = readFlat50Override();
  const percentList = readPercentPromosFromEnv();
  res.json({
    ok: true,
    flat50_env: flat?.code || null,
    percent_codes: percentList,
    query_code: q || null,
    isFlat50: q ? isFlat50For(q) : null,
    isOneDollar: q ? isOneDollarCode(q) : null
  });
});

// Quick debug for one-dollar mode
app.get("/admin/promo/onedollar", corsAllow, (req, res) => {
  const code = String(req.query.code || "").trim();
  res.json({ ok:true, query: code || null, isOneDollar: isOneDollarCode(code) });
});

// Generate missing mockups for a product (admin tool) - now persists to Supabase Storage
// Generate mockups for ALL products (batch processing)
app.post("/admin/mockups/generate-all", corsAllow, express.json(), async (req, res) => {
  try {
    // Temporarily disable auth for testing
    // if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    
    // Get all Printful products
    const storeId = process.env.PRINTFUL_STORE_ID;
    const headers = { Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}` };
    const base = "https://api.printful.com";
    const r = await fetch(`${base}/store/products?store_id=${storeId}&limit=100`, { headers });
    const json = await r.json();
    const products = json?.result || [];
    
    const results = [];
    let processed = 0;
    
    for (const product of products) {
      try {
        const productId = String(product.id);
        console.log(`🎨 Generating mockups for product ${productId}: ${product.name}`);
        
        // Get product details
        const productResp = await pfFetch(`/store/products/${productId}`, { method: 'GET' });
        const svs = productResp?.result?.sync_variants || [];
        const existingFiles = [];
        
        for (const sv of svs) {
          for (const f of sv.files || []) {
            if (f.preview_url || f.thumbnail_url) existingFiles.push(f);
          }
        }
        
        // Generate mockups
        const angleUrlsByColor = await generateMissingMockups(productId, svs.map(sv => sv.variant_id), existingFiles, product.name);
        
        // Upload and persist
        const persisted = {};
        for (const [color, angles] of Object.entries(angleUrlsByColor || {})) {
          const out = {};
          for (const angle of ["front","back","left","right"]) {
            const src = angles[angle];
            if (!src || !Array.isArray(src) || !src.length) continue;
            try {
              const publicUrl = await uploadMockupAndGetPublicUrl({ productId, color, angle, sourceUrl: src[0] });
              out[angle] = publicUrl;
            } catch (e) {
              console.warn(`Failed to upload ${color}/${angle}:`, e.message);
            }
          }
          if (Object.keys(out).length) persisted[color] = out;
        }
        
        if (Object.keys(persisted).length > 0) {
          const merged = await mergeCustomMockupsInDB(productId, persisted);
          results.push({ productId, name: product.name, custom_mockups: merged });
        }
        
        processed++;
        
        // Add delay to avoid rate limiting
        if (processed < products.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (e) {
        console.error(`Failed to generate mockups for product ${product.id}:`, e.message);
        results.push({ productId: String(product.id), name: product.name, error: e.message });
      }
    }
    
    res.json({ 
      ok: true, 
      processed,
      total: products.length,
      results,
      message: `Processed ${processed}/${products.length} products`
    });
    
  } catch (e) {
    console.error('Batch mockup generation error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/mockups/generate", corsAllow, express.json(), async (req, res) => {
  try {
    // Temporarily disable auth for testing  
    // if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    
    const productId = String(req.body?.productId || "").trim();
    const variantIds = Array.isArray(req.body?.variantIds) ? req.body.variantIds : undefined;
    if (!productId) return res.status(400).json({ ok:false, error:"missing productId" });

    // 1) Get existing files from the product
    const productResp = await pfFetch(`/store/products/${productId}`, { method: 'GET' });
    const svs = productResp?.result?.sync_variants || [];
    const existingFiles = [];
    
    for (const sv of svs) {
      for (const f of sv.files || []) {
        if (f.preview_url || f.thumbnail_url) existingFiles.push(f);
      }
    }
    
    // 2) Generate temporary mockups via Printful API  
    const productName = productResp?.result?.sync_product?.name || '';
    const angleUrlsByColor = await generateMissingMockups(productId, variantIds || svs.map(sv => sv.variant_id), existingFiles, productName);

    // 3) Upload each angle to Supabase Storage → get permanent public URLs
    const persisted = {};
    for (const [color, angles] of Object.entries(angleUrlsByColor || {})) {
      const out = {};
      for (const angle of ["front","back","left","right"]) {
        const src = angles[angle];
        if (!src || !Array.isArray(src) || !src.length) continue;
        try {
          const publicUrl = await uploadMockupAndGetPublicUrl({ productId, color, angle, sourceUrl: src[0] });
          out[angle] = publicUrl;
        } catch (e) {
          console.warn(`Failed to upload ${color}/${angle}:`, e.message);
        }
      }
      if (Object.keys(out).length) persisted[color] = out;
    }

    // 4) Merge into product_overrides.custom_mockups
    const merged = await mergeCustomMockupsInDB(productId, persisted);

    res.json({ 
      ok: true, 
      productId, 
      custom_mockups: merged,
      message: 'Mockup generation and storage completed'
    });
  } catch (e) {
    console.error('Admin mockup generation error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/promo/validate', corsAllow, express.json(), (req, res) => {
  try {
    const given = String(req.body?.code || '').trim();
    if (!given) return res.status(400).json({ ok:false, error:"missing_code" });

    // ONE-DOLLAR override wins first (TAKE5 -> $1 total)
    if (isOneDollarCode(given)) {
      return res.json({ ok:true, code: given, percent: 0, mode: "oneDollar" });
    }

    // flat-50 override second
    if (isFlat50For(given)) {
      return res.json({ ok:true, code: given, percent: 0, mode: "flat50" });
    }

    // then percent codes (code1..code5)
    const list = readPercentPromosFromEnv();
    const hit = list.find(p => p.code.toLowerCase() === given.toLowerCase());
    if (hit) return res.json({ ok:true, code: hit.code, percent: hit.percent, minCents: 50 });

    return res.status(404).json({ ok:false });
  } catch (e) {
    console.error('Validate error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ===== DONATIONS: Create Stripe Checkout session =====
app.post("/donate/create-checkout-session", cors(), async (req, res) => {
  try {
    const { amount } = req.body || {};
    const dollars = Number(amount);
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(cents) || cents < DON_MIN || cents > DON_MAX) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: "Charitable Donation to Catfish Empire",
            metadata: { type: "donation" }
          },
          unit_amount: cents
        },
        quantity: 1
      }],
      automatic_tax: { enabled: false },
      success_url: `${process.env.CLIENT_URL}/success.html?donation=1`,
      cancel_url: `${process.env.CLIENT_URL}/`,
      metadata: { intent: "donation", donation_cents: String(cents) },
      payment_intent_data: {
        description: "Charitable Donation to Catfish Empire",
        metadata: { intent: "donation", donation_cents: String(cents) }
      }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Donation session error:", e);
    res.status(500).json({ error: "Donation checkout failed" });
  }
});

// Admin: upload mockup via base64
app.post('/admin/mockups/upload', async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const { productId, color, view, filename, contentType, base64 } = req.body || {};
    if (!productId || !color || !filename || !base64) return res.status(400).json({ error: 'Missing fields' });
    const buffer = Buffer.from(String(base64).split(',').pop(), 'base64');
    const saved = await uploadMockupToSupabase({ productId, color, view: (view||'').toLowerCase(), filename, contentType: contentType || 'image/webp', buffer });
    const colorKey = String(color).toLowerCase();
    const { data: existing } = await supabase.from('product_overrides').select('*').eq('product_id', productId).maybeSingle();
    const cm = existing?.custom_mockups || {};
    cm[colorKey] = cm[colorKey] || { views: {}, images: [] };
    if (view && !cm[colorKey].views?.[view]) {
      cm[colorKey].views[view] = saved.url;
    }
    if (!cm[colorKey].images.includes(saved.url)) cm[colorKey].images.push(saved.url);
    const upsert = { product_id: productId, custom_mockups: cm };
    const { error: upErr } = await supabase.from('product_overrides').upsert(upsert);
    if (upErr) throw upErr;
    res.json({ ok: true, url: saved.url, path: saved.path });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: delete mockup
app.post('/admin/mockups/delete', async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const { productId, color, url, path } = req.body || {};
    if (!productId || !color || !url) return res.status(400).json({ error: 'Missing fields' });
    const colorKey = String(color).toLowerCase();
    const { data: existing } = await supabase.from('product_overrides').select('*').eq('product_id', productId).maybeSingle();
    const cm = existing?.custom_mockups || {};
    if (cm[colorKey]) {
      cm[colorKey].images = (cm[colorKey].images || []).filter(u => u !== url);
      cm[colorKey].views = cm[colorKey].views || {};
      for (const k of Object.keys(cm[colorKey].views)) {
        if (cm[colorKey].views[k] === url) cm[colorKey].views[k] = null;
      }
    }
    const upsert = { product_id: productId, custom_mockups: cm };
    const { error: upErr } = await supabase.from('product_overrides').upsert(upsert);
    if (upErr) throw upErr;
    if (path) { try { await removeMockupFromSupabase(path); } catch(_){} }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN/DEBUG: Printful last order =====
app.get('/admin/printful/last', cors(), async (req, res) => {
  if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
  res.json({ ...LAST_PF_ORDER });
});

// Admin endpoint to re-confirm by external_id (recover stuck drafts)
app.post("/admin/printful/reconfirm", cors(), async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const external_id = String(req.body?.external_id || "").trim();
    if (!external_id) return res.status(400).json({ ok:false, error:"missing external_id" });

    const rec = await getOrderByExternalId(external_id);
    if (!rec?.pf_order_id) return res.status(404).json({ ok:false, error:"order_not_found" });

    const confirmRes = await printfulConfirmOrder(rec.pf_order_id);
    await upsertOrderRecord({
      external_id,
      pf_order_id: rec.pf_order_id,
      status: "confirmed",
      meta: { reconfirmed_at: new Date().toISOString(), confirmRes }
    });

    return res.json({ ok:true, external_id, pf_order_id: rec.pf_order_id });
  } catch (e) {
    console.error("admin reconfirm error:", e?.message || e);
    return res.status(500).json({ ok:false, error: e?.message || "reconfirm_failed" });
  }
});

// Debug a specific order quickly
app.get("/admin/printful/order/:external_id", cors(), async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const external_id = req.params.external_id;
    const rec = await getOrderByExternalId(external_id);
    if (!rec?.pf_order_id) return res.status(404).json({ ok:false });
    const live = await printfulGetOrder(rec.pf_order_id);
    return res.json({ ok:true, record: rec, live });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || String(e), record: rec });
  }
});

// Admin cancel endpoint (manual recovery)
app.post("/admin/printful/cancel", cors(), async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const external_id = String(req.body?.external_id || "").trim();
    if (!external_id) return res.status(400).json({ ok:false, error:"missing external_id" });

    const rec = await getOrderByExternalId(external_id);
    if (!rec?.pf_order_id) return res.status(404).json({ ok:false, error:"order_not_found" });

    const live = await printfulGetOrder(rec.pf_order_id);
    const status = (live?.result?.status || "").toLowerCase();
    if (/fulfilled|shipped|canceled/.test(status)) {
      return res.json({ ok:true, external_id, pf_order_id: rec.pf_order_id, message: `No action: status=${status}` });
    }

    const out = await printfulCancelOrder(rec.pf_order_id);
    await cancelOrderRecord({
      external_id: rec.external_id,
      pf_order_id: rec.pf_order_id,
      refund_status: "admin_cancel"
    });
    return res.json({ ok:true, external_id, pf_order_id: rec.pf_order_id, result: out });
  } catch (e) {
    console.error("admin cancel error:", e?.message || e);
    return res.status(500).json({ ok:false, error: e?.message || "cancel_failed" });
  }
});

// Admin/Debug: token bypass to view last PF payload/response
const DEBUG_TOKEN = process.env.ADMIN_DEBUG_TOKEN || '';
app.get('/admin/printful/debug', cors(), async (req, res) => {
  const okByToken = DEBUG_TOKEN && req.query.token === DEBUG_TOKEN;
  const okBySession = !!(req.session?.authenticated) || req.session?.isAdmin === true;
  if (!okByToken && !okBySession) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    decoded:  globalThis.__LAST_PF_DECODED__  || null,
    items:    globalThis.__LAST_PF_ITEMS__    || null,
    lastPayload:  globalThis.__LAST_PF_PAYLOAD__  || null,
    lastResponse: globalThis.__LAST_PF_RESPONSE__ || null
  });
});

// Quick debug endpoint to verify a store sync variant id
app.get('/admin/printful/variant/:id', cors(), async (req, res) => {
  try{
    const DEBUG_TOKEN2 = process.env.ADMIN_DEBUG_TOKEN || '';
    if (!(DEBUG_TOKEN2 && req.query.token === DEBUG_TOKEN2)) return res.status(401).json({error:'unauthorized'});

    const id = String(req.params.id);
    const storeId = process.env.PRINTFUL_STORE_ID;
    const url = storeId
      ? `https://api.printful.com/store/variants/${encodeURIComponent(id)}?store_id=${encodeURIComponent(storeId)}`
      : `https://api.printful.com/store/variants/${encodeURIComponent(id)}`;

    const r = await fetch(url, {
      headers:{
        'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });
    const text = await r.text();
    res.status(r.status).send(text);
  } catch(e){
    res.status(500).json({error:String(e.message||e)});
  }
});

// ===== ADMIN/DEBUG: Trigger a test PF order (draft) =====
app.post('/admin/printful/test-order', cors(), async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const { variantId, quantity, address } = req.body || {};
    const fakeSession = {
      id: `test_${Date.now()}`,
      shipping_details: { name: 'Test User', address: {
        line1: address?.line1 || '123 Test St',
        line2: address?.line2 || '',
        city: address?.city || 'Raleigh',
        state: address?.state || 'NC',
        postal_code: address?.postal_code || '27601',
        country: address?.country || 'US'
      }}
    };
    const items = [{ type:'printful', variantId: Number(variantId), quantity: Math.max(1, Number(quantity||1)) }];
    const out = await createPrintfulOrder({ session: fakeSession, items, confirm: false });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, last: LAST_PF_ORDER });
  }
});

// Admin: add mockups to a color (optional view)
app.post('/admin/mockup/by-color', async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const { product_id, color, urls, view } = req.body || {};
    if (!product_id || !color || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'product_id, color, urls[] required' });
    }
    const ck = normColor(color);
    const vv = validView(view);
    const { data: row } = await supabase
      .from('product_overrides')
      .select('product_id, custom_by_color')
      .eq('product_id', product_id)
      .maybeSingle();
    const base = row?.custom_by_color || {};
    if (!base[ck]) base[ck] = { images: [], views: { front:[], back:[], left:[], right:[] } };
    const dest = base[ck];
    const pushUnique = (arr, list) => (arr||[]).forEach(u => { if (u && !list.includes(u)) list.push(u); });
    if (vv) pushUnique(urls, dest.views[vv]); else pushUnique(urls, dest.images);
    const { error: upErr } = await supabase
      .from('product_overrides')
      .upsert({ product_id, custom_by_color: base }, { onConflict: 'product_id' });
    if (upErr) throw upErr;
    res.json({ ok: true, custom_by_color: base });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: delete mockups from a color (optional view)
app.delete('/admin/mockup/by-color', async (req, res) => {
  try {
    if (!req.session?.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const { product_id, color, urls, view } = req.body || {};
    if (!product_id || !color || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'product_id, color, urls[] required' });
    }
    const ck = normColor(color);
    const vv = validView(view);
    const { data: row } = await supabase
      .from('product_overrides')
      .select('custom_by_color')
      .eq('product_id', product_id)
      .maybeSingle();
    const base = row?.custom_by_color || {};
    if (!base[ck]) return res.json({ ok: true, custom_by_color: base });
    const strip = (arr=[]) => arr.filter(u => !urls.includes(u));
    if (vv) base[ck].views[vv] = strip(base[ck].views[vv]); else base[ck].images = strip(base[ck].images);
    const { error: upErr } = await supabase
      .from('product_overrides')
      .upsert({ product_id, custom_by_color: base }, { onConflict: 'product_id' });
    if (upErr) throw upErr;
    res.json({ ok: true, custom_by_color: base });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Persist drag-and-drop product ordering
app.post('/admin/product-sort', async (req, res) => {
  try {
    if (!req.session.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: 'Missing order array' });
    const rows = order.map((id, idx) => ({ product_id: String(id), sort_index: idx }));
    if (rows.length === 0) return res.json({ ok: true, count: 0 });
    const { error } = await supabase.from('product_sort').upsert(rows, { onConflict: 'product_id' });
    if (error) throw error;
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PRODUCT OVERRIDES (Admin) =====
// GET existing override by product id
app.get('/admin/product-override/:id', async (req, res) => {
  try {
    if (!req.session.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const pid = String(req.params.id);
    const { data, error } = await supabase
      .from('product_overrides')
      .select('*')
      .eq('product_id', pid)
      .limit(1);
    if (error) throw error;
    res.json(Array.isArray(data) ? (data[0] || {}) : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPSERT override
app.post('/admin/product-override/:id', async (req, res) => {
  try {
    if (!req.session.authenticated) return res.status(403).json({ error: 'Not logged in' });
    const pid = String(req.params.id);
    const body = req.body || {};
    const row = {
      product_id: pid,
      title_override: body.title_override || null,
      description_override: body.description_override || null,
      custom_mockups: Array.isArray(body.custom_mockups) ? body.custom_mockups : [],
      hidden_mockups: Array.isArray(body.hidden_mockups) ? body.hidden_mockups : []
    };
    const { data, error } = await supabase
      .from('product_overrides')
      .upsert(row, { onConflict: 'product_id' })
      .select()
      .limit(1);
    if (error) throw error;
    res.json({ success: true, row: Array.isArray(data) ? data[0] : data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick test endpoint for mockup generation (remove after testing)
app.get("/test/mockups/:productId", corsAllow, async (req, res) => {
  try {
    const productId = String(req.params.productId || "").trim();
    if (!productId) return res.status(400).json({ error: 'Missing product ID' });
    
    console.log(`🧪 Testing mockup generation for product ${productId}`);
    
    // Get product details
    const productResp = await pfFetch(`/store/products/${productId}`, { method: 'GET' });
    const product = productResp?.result;
    const svs = product?.sync_variants || [];
    const productName = product?.sync_product?.name || '';
    
    console.log(`📋 Product: ${productName}`);
    console.log(`🎨 Variants: ${svs.length}`);
    
    const existingFiles = [];
    for (const sv of svs) {
      for (const f of sv.files || []) {
        if (f.preview_url || f.thumbnail_url) existingFiles.push(f);
      }
    }
    
    console.log(`📁 Existing files: ${existingFiles.length}`);
    
    // Generate mockups
    const angleUrlsByColor = await generateMissingMockups(productId, svs.map(sv => sv.variant_id), existingFiles, productName);
    
    res.json({
      ok: true,
      productId,
      productName,
      variantCount: svs.length,
      existingFiles: existingFiles.length,
      generatedAngles: Object.keys(angleUrlsByColor || {}),
      mockups: angleUrlsByColor
    });
    
  } catch (e) {
    console.error(`❌ Test mockup error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== STRIPE CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  const { items, shippingState } = req.body;
  let { promoCode } = req.body;
  if (Array.isArray(promoCode)) promoCode = promoCode[0] || '';
  if (typeof promoCode === 'string' && promoCode.includes(',')) promoCode = promoCode.split(',')[0].trim();
  promoCode = (promoCode || '').toLowerCase().trim();
  if (!items || !Array.isArray(items))
    return res.status(400).json({ error: "Invalid cart format" });

  try {
    // Create line items with dynamic pricing based on product type
    const activePromo = getActivePromo(req);
    const isOneDollarOverride = isOneDollarCode(promoCode) || isOneDollarCode(activePromo?.code);
    const isFlat50Override = !isOneDollarOverride && (isFlat50For(promoCode) || isFlat50For(activePromo?.code));
    
    // Store real cart items in metadata for webhook Printful order creation
    const printfulItems = items
      .filter(it => it.type === 'printful' && it.variantId)
      .map(it => ({ sync_variant_id: Number(it.variantId), quantity: Math.max(1, Number(it.qty) || 1) }));
    
    let line_items = [];
    
    if (isOneDollarOverride) {
      // TAKE5 -> single $1.00 line item
      const orderSummaryName = items.length ? `${items[0].name || 'Item'} +${Math.max(0, items.length-1)} more` : "Order";
      line_items = [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 100,
          product_data: { name: `TAKE5 Test — ${orderSummaryName}` }
        }
      }];
    } else {
    for (const item of items) {
      if (item.type === 'printful') {
        let variantId = item.variantId || item.variant_id;
        let priceInCents = Number.isFinite(item.priceCents) ? Number(item.priceCents) : Math.round((item.price || 0) * 100);
        let name = item.name || 'Catfish Empire Product';
        let image = item.image || '';

        // Reconstruct variant if missing
        if (!variantId && item.productId && item.color && item.size) {
          try {
            const full = await getPrintfulProductDetailCached(item.productId, process.env.PRINTFUL_API_KEY);
            const d = full?.result || {};
            const key = `${String(item.color).toLowerCase()}|${String(item.size).toLowerCase()}`;
            variantId = (d.variantMatrix && d.variantMatrix[key]) || (full.variantMatrix && full.variantMatrix[key]);
            const pbk = (full.priceByKey || d.priceByKey || {});
            if (pbk[key]) priceInCents = pbk[key];
            const gbc = (full.galleryByColor || d.galleryByColor || {});
            const col = gbc[String(item.color).toLowerCase()];
            image = image || col?.views?.front || col?.images?.[0] || (d.images?.[0]) || image;
            name = d.name || name;
          } catch (e) {
            console.warn('Variant reconstruction failed:', e.message);
          }
        }

        // Validate or enrich via variant fetch
        if (variantId) {
          try {
            const v = await fetchPrintfulVariantDetails(variantId);
            name = v.name || name;
            image = v.image_url || image;
            if (!priceInCents) priceInCents = Math.round((v.price || 0) * 100);
          } catch (e) {
            console.warn('Variant fetch failed, using provided price:', e.message);
          }
        }
        priceInCents = isFlat50Override ? 50 : priceAfterPromo(priceInCents, activePromo?.percent);
        if (!priceInCents || priceInCents < TEST_MIN_CHARGE_CENTS) {
          return res.status(400).json({ error: `Printful variant price invalid for variant ${variantId || 'unknown'} (computed ${priceInCents}c).` });
        }
        line_items.push({
          price_data: {
            currency: (item.currency || 'USD').toLowerCase(),
            product_data: {
              name,
              images: image ? [image] : [],
              metadata: {
                ...(variantId ? { printful_variant_id: String(variantId) } : {}),
                product_id: String(item.productId || ''),
                color: String(item.color || ''),
                size: String(item.size || ''),
                external_id: item.external_id ? String(item.external_id) : undefined
              }
            },
            unit_amount: priceInCents
          },
          quantity: item.qty || 1
        });
      } else {
        // Sunglasses product - use existing hardcoded pricing
        let priceInCents = isFlat50Override ? 50 : 1499;
        if (!isFlat50Override) priceInCents = priceAfterPromo(priceInCents, activePromo?.percent);
        line_items.push({
        price_data: {
          currency: "usd",
          product_data: { name: `Catfish Empire™ ${item.color} Sunglasses` },
          unit_amount: priceInCents,
        },
        quantity: item.qty,
        });
      }
    }
    }

    // Flat shipping rate for all orders (promo does not affect shipping)
    const isTestPromo = false;
    const shippingOptions = [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: isFlat50Override ? 0 : 599, currency: "usd" },
            display_name: isFlat50Override ? "Free Shipping (Promo)" : "Flat Rate Shipping",
          },
        },
    ];

    // Build compact metadata + store real cart for webhook Printful order
    const metadata = {};
    (items || []).forEach((it, idx) => { metadata[`i${idx}`] = packItem(it); });
    metadata.cart_count = String(items ? items.length : 0);
    metadata.promo_code = activePromo?.code || promoCode || '';
    metadata.mode = isOneDollarOverride ? 'oneDollar' : (isFlat50Override ? 'flat50' : 'normal');
    metadata.order_cart = JSON.stringify({ items: printfulItems });
    if (shippingState) metadata.shippingState = String(shippingState);

    const sessionParams = {
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items,
      metadata,
      automatic_tax: { enabled: !isOneDollarOverride && !isFlat50Override },
      success_url: `${process.env.CLIENT_URL}/success.html`,
      cancel_url: `${process.env.CLIENT_URL}/cart.html`,
    };
    // Require shipping address only if cart contains Printful items
    const hasPrintful = Array.isArray(items) && items.some(i => i.type === 'printful');
    if (hasPrintful) {
      sessionParams.shipping_address_collection = { allowed_countries: ["US","CA"] };
    }
    if (isOneDollarOverride) {
      sessionParams.shipping_options = [{
        shipping_rate_data: {
          display_name: "Free Shipping — TAKE5 Test",
          type: "fixed_amount",
          fixed_amount: { amount: 0, currency: "usd" }
        }
      }];
    } else {
      sessionParams.shipping_options = shippingOptions;
    }
    // Validate multiple items have valid unit amounts
    for (const li of line_items) {
      const amt = li?.price_data?.unit_amount;
      if (!Number.isFinite(amt) || amt < 50) {
        return res.status(400).json({ error: `Invalid unit amount ${amt} on a line item.` });
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    const msg = (err && err.message) ? err.message : 'Checkout failed';
    res.status(500).json({ error: msg });
  }
});

// ===== STRIPE WEBHOOK =====
app.post("/webhook", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const firstTime = await markStripeEventProcessedOnce(event.id, event.type);
    if (!firstTime) {
      return res.status(200).send("[ok] duplicate event ignored");
    }

    const session = event.data.object;
    const stripeCheckoutId = session.id;

    const isDonation = session.metadata?.intent === "donation";
    if (isDonation) {
      try {
        const email = session.customer_email || session.customer_details?.email || "Unknown";
        const name = session.customer_details?.name || "Donor";
        const amount = (session.amount_total || 0) / 100;
        const when = new Date((event.created || Math.floor(Date.now()/1000)) * 1000);

        const donorMsg = `Thank you for supporting Catfish Empire!\n\nCharitable Donation to Catfish Empire\nAmount: $${amount.toFixed(2)}\nDate: ${when.toLocaleString()}\n\nWe appreciate your support!\n— Catfish Empire`;
        transporter.sendMail({
          from: `"Catfish Empire" <${process.env.SMTP_USER}>`,
          to: email,
          subject: "Thank you for your donation to Catfish Empire",
          text: donorMsg
        }, () => {});

        const adminMsg = `🧾 NEW DONATION\n\n👤 Donor: ${name} <${email}>\n💵 Amount: $${amount.toFixed(2)}\n🕒 Date: ${when.toLocaleString()}\n🔗 Stripe Session: ${session.id}\n`;
        transporter.sendMail({
          from: `"Catfish Empire" <${process.env.SMTP_USER}>`,
          to: "rich@richmediaempire.com",
          subject: "New Donation Received",
          text: adminMsg
        }, () => {});
      } catch (e) { console.error('Donation email error:', e.message); }
      return res.json({ received: true });
    }

    const items = unpackSessionItems(session);
    try { console.log('Decoded session items:', items.map(i => ({ t:i.type, pid:i.productId, vid:i.variantId, q:i.qty, c:i.color, s:i.size }))); } catch(_){}
    const shippingState = session.metadata?.shippingState || "Unknown";

    const shipping =
      session.shipping?.address ||
      session.collected_information?.shipping_details?.address ||
      {};

    const shippingName =
      session.shipping?.name || session.customer_details?.name || "No name";
    const email =
      session.customer_email || session.customer_details?.email || "Unknown email";

    let updated = [];
    const printfulLineItems = [];
    for (const item of items) {
      console.log(`🔍 Processing item:`, { type: item.type, color: item.color, qty: item.qty, inventoryHasColor: inventory[item.color] !== undefined });
      
      if (item.type === 'printful') {
        try {
          const safe = await coercePrintfulCartItem(item);
          printfulLineItems.push(safe);
          updated.push(`${safe.quantity} × ${safe.name} (Printful) - $${(safe.priceCents/100).toFixed(2)}`);
        } catch (e) {
          console.error('Coerce printful item failed in webhook:', e.message);
        }
      } else if (item.type === 'sunglasses' || inventory[item.color] !== undefined) {
        // Sunglasses products - update inventory (handle both old and new formats)
        const color = typeof item.color === 'string' ? item.color.trim() : item.color;
        const qty = item.qty || item.q || 1;
        const colorKey = typeof color === 'string' ? color.toLowerCase() : color;
        // Case-insensitive match for inventory colors
        let invKey = null;
        if (colorKey && inventory[colorKey] !== undefined) {
          invKey = colorKey;
        } else if (colorKey) {
          const found = Object.keys(inventory).find(k => String(k).toLowerCase() === colorKey);
          if (found) invKey = found;
        }
        console.log(`🥽 Processing sunglasses: color=${color} (invKey=${invKey}), qty=${qty}, currentInventory=${invKey!=null?inventory[invKey]:undefined}`);
        
        if (invKey != null) {
          const oldQty = inventory[invKey];
          const nextQty = Math.max(0, Number(oldQty) - Number(qty));
          inventory[invKey] = nextQty;
          console.log(`📦 Updating inventory: ${invKey} ${oldQty} → ${nextQty}`);
          await updateQuantity(invKey, nextQty);
          updated.push(`${qty} × ${color} Sunglasses - $14.99`);
        } else {
          console.log(`⚠️ Skipping sunglasses: color=${color} not in inventory or undefined`);
        }
      } else {
        console.log(`❓ Unknown item type: ${item.type}`);
      }
    }

    const promoNote = session.metadata?.promo_code ? `\n🎟️ Promo: ${session.metadata.promo_code} (${session.metadata.test_discount_applied}% off)` : '';
    const pfLines = printfulLineItems.map(safe => `PF: ${safe.quantity} × ${safe.name} — sync_variant_id=${safe.variantId} color=${safe.color||'n/a'} size=${safe.size||'n/a'}`).join("\n");
    const message = `🧾 NEW ORDER

👤 Name: ${shippingName}
📧 Email: ${email}

📦 Ship To:
${shipping.line1 || ""} ${shipping.line2 || ""}
${shipping.city || ""}, ${shipping.state || ""} ${shipping.postal_code || ""}
${shipping.country || "USA"}
🗺️ Shipping State (client-supplied): ${shippingState}

🛍️ Items:
${updated.join("\n")}
${pfLines ? `\n${pfLines}` : ''}

💰 Total: $${items.reduce((sum, item) => {
  const price = item.type === 'printful' ? item.price : 14.99;
  return sum + (price * item.qty);
}, 0).toFixed(2)} + $5.99 shipping + tax${promoNote}${LAST_PF_ORDER?.error ? "\n⚠️ Printful error recorded; see /admin/printful/last" : ''}
`;

    transporter.sendMail(
      {
        from: `"Catfish Empire" <${process.env.SMTP_USER}>`,
        to: "rich@richmediaempire.com",
        subject: "New Order Received",
        text: message,
      },
      (err) => {
        if (err) console.error("❌ Email failed:", err);
        else console.log("📨 Order email sent");
      }
    );

    // Attempt to create a Printful draft using robust recovery + diagnostics
    globalThis.__LAST_PF_DECODED__   = null;
    globalThis.__LAST_PF_ITEMS__     = null;
    globalThis.__LAST_PF_PAYLOAD__   = null;
    globalThis.__LAST_PF_RESPONSE__  = null;
    try {
      const sess = await stripe.checkout.sessions.retrieve(session.id, { expand: ['payment_intent','customer','customer_details'] });
      try { await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] }); } catch(_){ }
      const token   = process.env.PRINTFUL_API_KEY;
      const storeId = process.env.PRINTFUL_STORE_ID;
      const decoded = items.map(x => ({ t: x.type || x.t, pid: Number(x.productId || x.pid || x.id || 0) || null, vid: Number(x.variantId || x.variant_id || x.vid || 0) || null, q: Number(x.qty || x.q || 1) || 1, c: x.color || x.c || '', s: x.size  || x.s || '' }));
      globalThis.__LAST_PF_DECODED__ = decoded;
      const pfItems = token ? await buildPrintfulItems(decoded, token, storeId) : [];
      // annotate for clarity in debug
      const debugItems = pfItems.map(x => ({ ...x }));
      globalThis.__LAST_PF_ITEMS__ = debugItems;
      if (token && pfItems.length){
        const recipient = stripeToPrintfulRecipient(sess);
        const incomplete = !recipient.address1 || !recipient.city || !recipient.state_code || !recipient.country_code || !recipient.zip;
        if (incomplete){
          console.warn('SKIP Printful: recipient incomplete', recipient);
          globalThis.__LAST_PF_RESPONSE__ = { status:'SKIP', text:'Recipient incomplete', recipient };
        } else {
          const external_id = mkPfExternalId(stripeCheckoutId);
          const autoConfirm = String(process.env.PRINTFUL_AUTO_CONFIRM || "").toLowerCase() === "true";
          
          // Capture PI and charge for refund mapping
          let piId = session.payment_intent || null;
          let chargeId = null;
          let amountCaptured = null;
          let currency = (session.currency || "usd").toLowerCase();
          try {
            if (piId) {
              const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
              amountCaptured = Number(pi.amount_received ?? pi.amount ?? null);
              currency = (pi.currency || currency || "usd").toLowerCase();
              chargeId = (pi.latest_charge && typeof pi.latest_charge === "object")
                ? pi.latest_charge.id
                : (pi.latest_charge || null);
            }
          } catch (e) {
            console.warn("Could not retrieve PI.latest_charge:", e?.message || e);
          }

          // Replay safety: if order exists for this external_id, don't recreate
          const existing = await getOrderByExternalId(external_id);
          if (existing?.pf_order_id) {
            if (autoConfirm && (existing.status !== "confirmed" && existing.status !== "pending")) {
              try {
                await printfulConfirmOrder(existing.pf_order_id);
                await upsertOrderRecord({
                  external_id,
                  pf_order_id: existing.pf_order_id,
                  status: "confirmed",
                  meta: { resumed: true },
                  pi_id: piId,
                  charge_id: chargeId,
                  amount_captured: amountCaptured,
                  currency: currency,
                  last_event_type: "checkout.session.completed"
                });
              } catch (e) {
                console.error("Re-confirm existing PF order failed:", e?.message || e);
                await notifyOps("rich@richmediaempire.com",
                  opsEmailSubject(external_id, "Re-confirm failed"),
                  `<pre>${(e?.message || e).toString()}</pre>`);
              }
            }
            globalThis.__LAST_PF_RESPONSE__ = { status:'REPLAY', text:'Existing order acknowledged', orderId: existing.pf_order_id };
          } else {
            // Get real cart items from metadata OR fall back to decoded session items
            let itemsFromMeta = [];
            try {
              if (session.metadata?.order_cart) {
                const parsed = JSON.parse(session.metadata.order_cart);
                if (Array.isArray(parsed?.items)) itemsFromMeta = parsed.items;
              }
            } catch (e) {
              console.warn("order_cart metadata parse failed:", e?.message || e);
            }

            // Fallback: use decoded session items if no metadata
            if (!itemsFromMeta.length) {
              console.log('No order_cart metadata, falling back to decoded session items...');
              const decoded = items.map(x => ({ t: x.type || x.t, pid: Number(x.productId || x.pid || x.id || 0) || null, vid: Number(x.variantId || x.variant_id || x.vid || 0) || null, q: Number(x.qty || x.q || 1) || 1, c: x.color || x.c || '', s: x.size || x.s || '' }));
              console.log('Decoded items:', decoded);
              const pfItems = await buildPrintfulItems(decoded, token, storeId);
              console.log('Built PF items:', pfItems);
              itemsFromMeta = pfItems.map(x => ({ sync_variant_id: x.sync_variant_id, quantity: x.quantity }));
            }

            console.log('Final items for Printful:', itemsFromMeta);
            console.log('Recipient:', recipient);

            if (!itemsFromMeta.length) {
              console.error("No Printful items found in any source; order will not be created.");
              globalThis.__LAST_PF_RESPONSE__ = { status:'SKIP', text:'No items found' };
            } else {
              // Create DRAFT Printful order (back to original working method)
              let created, pfOrderId;
              try {
                const orderPayload = {
                  external_id,
                  confirm: false,
                  update_existing: false,
                  recipient,
                  items: itemsFromMeta.map(x => ({ sync_variant_id: Number(x.sync_variant_id), quantity: Number(x.quantity) }))
                };
                globalThis.__LAST_PF_PAYLOAD__ = { when: Date.now(), body: orderPayload };
                created = await printfulCreateOrderDraft(orderPayload);
                pfOrderId = created?.result?.id || created?.result?.order?.id || created?.id;
                await upsertOrderRecord({
                  external_id,
                  pf_order_id: pfOrderId,
                  status: "draft",
                  meta: { create_res: created },
                  pi_id: piId,
                  charge_id: chargeId,
                  amount_captured: amountCaptured,
                  amount_refunded: 0,
                  currency: currency,
                  last_event_type: "checkout.session.completed"
                });
                console.log(`Printful order ${pfOrderId} created as draft (original working method)`);
                globalThis.__LAST_PF_RESPONSE__ = { status: 200, text: JSON.stringify(created), orderId: pfOrderId };
              } catch (e) {
                console.error("Printful create draft failed:", e?.message || e);
                await upsertOrderRecord({
                  external_id,
                  pf_order_id: null,
                  status: "failed",
                  meta: { error: e?.message || String(e) },
                  pi_id: piId,
                  charge_id: chargeId,
                  amount_captured: amountCaptured,
                  currency: currency,
                  last_event_type: "checkout.session.completed"
                });
                await notifyOps("rich@richmediaempire.com",
                  opsEmailSubject(external_id, "Printful create failed"),
                  `<pre>${(e?.message || e).toString()}</pre>`);
                globalThis.__LAST_PF_RESPONSE__ = { status:'EXCEPTION', text: String(e?.message||e) };
              }
            }
          }
        }
      } else {
        globalThis.__LAST_PF_RESPONSE__ = { status:'SKIP', text: token ? 'No pfItems' : 'No PRINTFUL_API_KEY' };
      }
    } catch (e) { console.error('Printful order attempt failed:', e?.message || e); globalThis.__LAST_PF_RESPONSE__ = { status:'EXCEPTION', text:String(e?.message||e) }; }

    console.log("✅ Inventory updated from payment");
  }

  // ---- Refund completed: cancel only on full refund ----
  if (event.type === "charge.refunded") {
    const firstTime = await markStripeEventProcessedOnce(event.id, event.type);
    if (!firstTime) return res.status(200).send("[ok] duplicate refund event ignored");

    const charge = event.data.object;
    const chargeId = charge.id;
    const piId = charge.payment_intent || null;
    
    function getRefundSnapshotFromCharge(charge) {
      const amountCaptured = Number(charge.amount_captured ?? charge.amount ?? 0);
      const amountRefunded = Number(charge.amount_refunded ?? 0);
      const currency = (charge.currency || "usd").toLowerCase();
      const full = amountCaptured > 0 && amountRefunded >= amountCaptured;
      return { amountCaptured, amountRefunded, currency, full };
    }
    
    const snap = getRefundSnapshotFromCharge(charge);
    const rec = await findOrderByPIorCharge({ pi: piId, charge: chargeId });
    if (!rec?.pf_order_id) return res.status(200).send("[ok] no linked order");

    try {
      if (snap.full) {
        const live = await printfulGetOrder(rec.pf_order_id);
        const status = (live?.result?.status || "").toLowerCase();
        if (!/fulfilled|shipped|canceled/.test(status)) {
          await printfulCancelOrder(rec.pf_order_id);
        }
        await upsertOrderRecord({
          external_id: rec.external_id,
          pf_order_id: rec.pf_order_id,
          status: "canceled",
          amount_captured: snap.amountCaptured,
          amount_refunded: snap.amountRefunded,
          currency: snap.currency,
          last_event_type: event.type,
          cancel_reason: "stripe_full_refund"
        });
      } else {
        await upsertOrderRecord({
          external_id: rec.external_id,
          pf_order_id: rec.pf_order_id,
          status: rec.status,
          amount_captured: snap.amountCaptured,
          amount_refunded: snap.amountRefunded,
          currency: snap.currency,
          last_event_type: event.type,
          cancel_reason: null
        });
        await notifyOps("rich@richmediaempire.com",
          `[CatfishEmpire] Partial refund detected for ${rec.external_id}`,
          `<p>amount_captured: ${(snap.amountCaptured/100).toFixed(2)} ${snap.currency.toUpperCase()}<br>
             amount_refunded: ${(snap.amountRefunded/100).toFixed(2)} ${snap.currency.toUpperCase()}</p>
           <p>No auto-cancel performed (partial refund). If you wish to cancel, use:</p>
           <pre>POST /admin/printful/cancel {"external_id":"${rec.external_id}"}</pre>`);
      }
    } catch (e) {
      console.error("Refund handler failed:", e?.message || e);
      await notifyOps("rich@richmediaempire.com",
        `[CatfishEmpire] Refund handler error for ${rec.external_id}`,
        `<pre>${(e?.message || e).toString()}</pre>`);
    }
    return res.status(200).send("[ok]");
  }

  // ---- Async payment failed ----
  if (event.type === "checkout.session.async_payment_failed" || event.type === "payment_intent.payment_failed") {
    const firstTime = await markStripeEventProcessedOnce(event.id, event.type);
    if (!firstTime) return res.status(200).send("[ok] duplicate async fail ignored");

    let piId = null, rec = null;
    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object;
      piId = pi.id;
      rec = await findOrderByPIorCharge({ pi: piId });
    } else {
      const session = event.data.object;
      piId = session.payment_intent || null;
      rec = await findOrderByPIorCharge({ pi: piId });
    }

    if (!rec?.pf_order_id) return res.status(200).send("[ok] no linked order");

    try {
      const live = await printfulGetOrder(rec.pf_order_id);
      const status = (live?.result?.status || "").toLowerCase();
      if (!/fulfilled|shipped|canceled/.test(status)) {
        await printfulCancelOrder(rec.pf_order_id);
      }
      await cancelOrderRecord({
        external_id: rec.external_id,
        pf_order_id: rec.pf_order_id,
        refund_status: event.type
      });
    } catch (e) {
      console.error("Auto-cancel on async failure failed:", e?.message || e);
      await notifyOps("rich@richmediaempire.com",
        `[CatfishEmpire] Auto-cancel failed for ${rec.external_id}`,
        `<p>Stripe event: ${event.type}</p><p>pf_order_id: ${rec.pf_order_id}</p><pre>${(e?.message || e).toString()}</pre>`);
    }
    return res.status(200).send("[ok]");
  }

  res.json({ received: true });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 4242; // Render injects PORT
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
