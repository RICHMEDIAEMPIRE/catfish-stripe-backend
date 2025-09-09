// ===== ENV & CORE =====
require("dotenv").config();
const express = require("express");
const crypto = require('crypto');
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const fetch = require("node-fetch"); // v2 for CommonJS

const app = express();
app.set("trust proxy", 1);

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

let inventory = {};

async function loadInventory() {
  const { data, error } = await supabase
    .from("inventory")
    .select("color, quantity");
  if (error) throw error;
  const inv = {};
  data.forEach((i) => (inv[i.color.trim()] = i.quantity));
  return inv;
}

async function updateQuantity(color, qty) {
  const { error } = await supabase
    .from("inventory")
    .update({ quantity: qty })
    .eq("color", color);
  if (error) throw error;
}

loadInventory().then((inv) => (inventory = inv));

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

// === Promo codes from env: code1=(name)15 ... code10 ===
function loadPromoMapFromEnv() {
  const map = {};
  for (let i = 1; i <= 10; i++) {
    const raw = process.env[`code${i}`] || process.env[`CODE${i}`];
    if (!raw) continue;
    const m = String(raw).match(/^\(([^)]+)\)\s*(\d{1,2}|100)$/);
    if (!m) {
      console.warn(`Promo env code${i} is invalid. Expected (name)NN, got:`, raw);
      continue;
    }
    const code = m[1].trim().toLowerCase().replace(/\s+/g,'');
    const percent = parseInt(m[2], 10);
    if (percent >= 0 && percent <= 100) map[code] = percent;
  }
  return map;
}
let PROMO_MAP = loadPromoMapFromEnv();
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
  const safeView = (view || 'other').toLowerCase();
  const path = `printful/${String(productId)}/${String(color).toLowerCase()}/${safeView}/${filename}`;
  const { error } = await supabase.storage.from('mockups').upload(path, buffer, { contentType: contentType || 'image/webp', upsert: true });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('mockups').getPublicUrl(path);
  return { url: pub.publicUrl, path };
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

app.use(cors({ 
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }, 
  credentials: true 
}));
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

// Deterministic short external_id for Printful (<=64 chars)
function mkPfExternalId(stripeSessionId) {
  return 'cs_' + crypto.createHash('sha1').update(String(stripeSessionId||''))
    .digest('hex').slice(0,24);
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



// GET /api/printful-products → list cards { id, name, thumb, priceMinCents, currency:'USD', hasVariants:true }
app.get("/api/printful-products", cors(), async (req, res) => {
  try {
    const bypass = ("nocache" in req.query);
    const TTL = 15 * 60 * 1000;
    if (!global.pfCache) global.pfCache = { productsList: { data: null, ts: 0 }, productDetailById: {}, variantById: {} };
    const now = Date.now();
    const token = process.env.PRINTFUL_API_KEY;
    if (!token) return res.status(500).json({ error: 'Printful token missing' });

    // Return cached data if available
    if (!bypass && global.pfCache.productsList.data && now - global.pfCache.productsList.ts < TTL) {
      return res.json(global.pfCache.productsList.data);
    }

    // Fetch products list using withStoreId helper
    const baseListUrl = withStoreId('https://api.printful.com/store/products');
    const listResp = await fetch(baseListUrl, { headers: pfHeaders() });
    
    if (!listResp.ok) {
      console.error('❌ Unable to list products from Printful. Returning empty list.');
      const payload = { products: [], count: 0, timestamp: now };
      global.pfCache.productsList = { data: payload, ts: now };
      return res.json(payload);
    }

    const listJson = await listResp.json();
    const products = Array.isArray(listJson.result) ? listJson.result : [];

    const cards = [];
    for (const p of products) {
      try {
        const d = await getPrintfulProductDetailCached(p.id, token);
        const variants = d?.result?.sync_variants || [];
        let minCents = null;
        
        // Find minimum price from all variants
        for (const v of variants) {
          const cents = Math.round(parseFloat(v.retail_price || v.price || '0') * 100);
          if (isFinite(cents) && cents > 0) {
            minCents = minCents == null ? cents : Math.min(minCents, cents);
          }
        }
        
        // choose a default color cover if possible
        const sv0 = variants?.[0];
        const sp0 = d?.result?.sync_product || {};
        let thumb = p.thumbnail_url || sp0.thumbnail_url || '';
        let defaultColor = null;
        if (sv0) {
          const name = String(sv0?.name || '');
          const colorGuess = name.split(/[\/-]/)[0].trim();
          defaultColor = colorGuess || null;
          const files = sv0?.files || [];
          const front = files.find(f => (f.preview_url||'').toLowerCase().includes('front'));
          if (front?.preview_url) thumb = front.preview_url;
        }
        // If product detail already computed coverByColor, prefer that
        try {
          const detail = await getPrintfulProductDetailCached(p.id, token);
          const resultDetail = detail?.result || {};
          const svsDetail = Array.isArray(resultDetail.sync_variants) ? resultDetail.sync_variants : [];
          const galleryGuess = svsDetail?.[0]?.files || [];
          const front2 = galleryGuess.find(f => (f.preview_url||'').toLowerCase().includes('front'));
          if (front2?.preview_url) thumb = front2.preview_url;
          } catch {}
        cards.push({ 
          id: p.id, 
          name: (d?.result?.sync_product?.name) || p.name || 'Product', 
          thumb, 
          priceMinCents: minCents, 
          currency: 'USD', 
          hasVariants: true,
          defaultColor,
          // compat
          image: thumb,
          price: (minCents != null) ? (minCents / 100) : null
        });
        
        // Rate limiting
        await new Promise(r => setTimeout(r, 35));
      } catch (e) {
        console.warn('Card build failed for', p.id, e.message);
        cards.push({ 
          id: p.id, 
          name: p.name || 'Product', 
          thumb: p.thumbnail_url || '', 
          priceMinCents: null, 
          currency: null, 
          hasVariants: true,
          // compat fields for older frontends
          image: p.thumbnail_url || '',
          price: null
        });
      }
    }

    // Apply custom sort order if defined in Supabase
    try {
      const ids = cards.map(c => String(c.id));
      const { data: sorts } = await supabase
        .from('product_sort')
        .select('product_id, sort_index')
        .in('product_id', ids);
      if (Array.isArray(sorts) && sorts.length) {
        const idx = new Map();
        sorts.forEach(r => idx.set(String(r.product_id), Number(r.sort_index) || 0));
        cards.sort((a,b) => (idx.get(String(a.id)) ?? 1e9) - (idx.get(String(b.id)) ?? 1e9));
      }
    } catch (e) {
      // ignore sorting errors
    }

    const payload = { products: cards, count: cards.length, timestamp: now };
    if (!bypass) global.pfCache.productsList = { data: payload, ts: now };
    res.json(payload);
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
    const galleryByColor = {}; // colorLower -> { views: {front,back,left,right}, images: [] }
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
    const colors = [];
    const sizes = [];
    const variantMatrix = {};
    const priceByKey = {};
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
        // Merge color-aware overrides
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

    // Pick defaultColor: first variant's color that we have cover for; else first color; else null
    let defaultColor = null;
    // choose color with most views; tie-break alphabetically
    const colorScores = colors.map(c => {
      const key = String(c||'').toLowerCase();
      const g = galleryByColor[key]?.views || {};
      const score = ['front','back','left','right','left-front','right-front'].reduce((n,k2)=> n + (g[k2]?1:0), 0);
      return { c, score };
    });
    colorScores.sort((a,b)=> (b.score - a.score) || String(a.c).localeCompare(String(b.c)) );
    defaultColor = colorScores[0] ? colorScores[0].c : (colors[0] || null);
    const coverImage = coverByColor[String(defaultColor||'').toLowerCase()] || images[0] || null;

    // Ensure every color exposes all angle keys, borrowing from defaultColor when missing
    try {
      const orderedAngleKeys = ['front','left-front','right-front','left','right','back'];
      const defKey = String(defaultColor||'').toLowerCase();
      const defViews = (defKey && galleryByColor[defKey]?.views) ? galleryByColor[defKey].views : {};
      for (const [cKey, g] of Object.entries(galleryByColor)) {
        const v = g.views || {};
        // Borrow only the canonical angles front/back/left/right
        const borrowKeys = ['front','back','left','right'];
        for (const k of borrowKeys) { if (!v[k] && defViews && defViews[k]) { v[k]=defViews[k]; if (!g.images.includes(defViews[k])) g.images.push(defViews[k]); } }
        g.views = v;
        galleryByColor[cKey] = g;
      }
    } catch(_) {}
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
      coverImage
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
app.post('/api/promo/apply', cors(), express.json(), (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase().replace(/\s+/g,'');
  const pct = PROMO_MAP[code];
  if (!pct) return res.status(404).json({ ok: false, message: 'Invalid code' });
  setActivePromo(req, { code, percent: pct });
  res.json({ ok: true, code, percent: pct });
});

// Clear promo
app.post('/api/promo/clear', cors(), (_req, res) => {
  clearActivePromo(_req);
  res.json({ ok: true });
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
    const line_items = [];
    const activePromo = getActivePromo(req);
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
        priceInCents = priceAfterPromo(priceInCents, activePromo?.percent);
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
        let priceInCents = 1499;
        priceInCents = priceAfterPromo(priceInCents, activePromo?.percent);
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

    // Flat shipping rate for normal orders; waived for test promo
    const isTestPromo = (promoCode === TEST_PROMO_CODE);
    const shippingOptions = [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 599, currency: "usd" },
            display_name: "Flat Rate Shipping",
          },
        },
    ];

    // Build compact metadata
    const metadata = {};
    (items || []).forEach((it, idx) => { metadata[`i${idx}`] = packItem(it); });
    metadata.cart_count = String(items ? items.length : 0);
    if (shippingState) metadata.shippingState = String(shippingState);

    const sessionParams = {
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items,
      metadata: {
        ...metadata,
        promo_code: activePromo?.code || '',
        test_discount_applied: String(activePromo?.percent || 0)
      },
      automatic_tax: { enabled: !isTestPromo },
      success_url: `${process.env.CLIENT_URL}/success.html`,
      cancel_url: `${process.env.CLIENT_URL}/cart.html`,
    };
    // Require shipping address only if cart contains Printful items
    const hasPrintful = Array.isArray(items) && items.some(i => i.type === 'printful');
    if (hasPrintful) {
      sessionParams.shipping_address_collection = { allowed_countries: ["US","CA"] };
    }
    if (!isTestPromo) {
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
    const session = event.data.object;

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
      if (item.type === 'printful') {
        try {
          const safe = await coercePrintfulCartItem(item);
          printfulLineItems.push(safe);
          updated.push(`${safe.quantity} × ${safe.name} (Printful) - $${(safe.priceCents/100).toFixed(2)}`);
        } catch (e) {
          console.error('Coerce printful item failed in webhook:', e.message);
        }
      } else if (inventory[item.color] !== undefined) {
        // Sunglasses products - update inventory
        inventory[item.color] -= item.qty;
        await updateQuantity(item.color, inventory[item.color]);
        updated.push(`${item.qty} × ${item.color} Sunglasses - $14.99`);
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
          const external_id = mkPfExternalId(session.id || session.payment_intent || Date.now());
          const body = { external_id, confirm:false, recipient, items: pfItems };
          globalThis.__LAST_PF_PAYLOAD__ = { when: Date.now(), body };
          const pfResp = await pfPost('/orders', body);
          globalThis.__LAST_PF_RESPONSE__ = { status: pfResp.status, text: pfResp.text };
          if (!pfResp.ok) console.error('Printful order create failed:', pfResp.status, pfResp.text);
          else console.log('Printful order created (draft). Status:', pfResp.status);
        }
      } else {
        globalThis.__LAST_PF_RESPONSE__ = { status:'SKIP', text: token ? 'No pfItems' : 'No PRINTFUL_API_KEY' };
      }
    } catch (e) { console.error('Printful order attempt failed:', e?.message || e); globalThis.__LAST_PF_RESPONSE__ = { status:'EXCEPTION', text:String(e?.message||e) }; }

    console.log("✅ Inventory updated from payment");
  }

  res.json({ received: true });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 4242; // Render injects PORT
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
