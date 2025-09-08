// ===== ENV & CORE =====
require("dotenv").config();
const express = require("express");
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
        
        cards.push({ 
          id: p.id, 
          name: (d?.result?.sync_product?.name) || p.name || 'Product', 
          thumb: (p.thumbnail_url || d?.result?.sync_product?.thumbnail_url || ''), 
          priceMinCents: minCents, 
          currency: 'USD', 
          hasVariants: true,
          // compat fields for older frontends
          image: (p.thumbnail_url || d?.result?.sync_product?.thumbnail_url || ''),
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

    // Build gallery from all unique preview_url from sync_product.files and sync_variant.files, plus thumbnail_url
    const imageUrlsSet = new Set();
    if (sp.thumbnail_url) imageUrlsSet.add(sp.thumbnail_url);
    if (Array.isArray(sp.files)) {
      sp.files.forEach(f => { if (f.preview_url) imageUrlsSet.add(f.preview_url); });
    }
    svs.forEach(v => {
      (v.files || []).forEach(f => { if (f.preview_url) imageUrlsSet.add(f.preview_url); });
    });
    let images = Array.from(imageUrlsSet);

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
        .select('*')
        .eq('product_id', String(d.id || sp.id || prodId))
        .limit(1);
      const override = Array.isArray(overrideRows) ? overrideRows[0] : null;
      if (override) {
        if (Array.isArray(override.hidden_mockups)) {
          const hidden = new Set(override.hidden_mockups.map(String));
          images = images.filter(u => !hidden.has(String(u)));
        }
        if (Array.isArray(override.custom_mockups)) {
          const set = new Set(images.map(String));
          override.custom_mockups.forEach(u => { if (u && !set.has(String(u))) images.unshift(String(u)); });
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

    console.log(`🧩 /api/printful-product/${prodId}: variants=${count}`);

    res.json({
      id: d.id || sp.id || Number(prodId),
      name: sp.name || d.name || 'Printful Product',
      description: sp.description || d.description || null,
      images,
      options: { colors, sizes },
      variants,
      variantMatrix
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
  if (!items || !Array.isArray(items))
    return res.status(400).json({ error: "Invalid cart format" });

  try {
    // Create line items with dynamic pricing based on product type
    const line_items = [];
    for (const item of items) {
      if (item.type === 'printful') {
        // Ensure we have a variantId; if missing, infer a default from product details
        let variantId = item.variantId || item.variant_id;
        let inferred = false;
        let v;
        if (!variantId) {
          try {
            const full = await getPrintfulProductDetailCached(item.productId || item.id, process.env.PRINTFUL_API_KEY);
            const svs = full?.result?.sync_variants || [];
            const priced = svs
              .map(sv => ({ sv, cents: Math.round(parseFloat(sv.retail_price || sv.price || '0') * 100) }))
              .filter(x => isFinite(x.cents) && x.cents > 0)
              .sort((a,b)=>a.cents-b.cents);
            if (!priced.length) throw new Error('No priced variants');
            variantId = priced[0].sv.id;
            v = { 
              price: priced[0].sv.retail_price || priced[0].sv.price,
              name: priced[0].sv.name,
              image_url: (priced[0].sv.files||[]).find(f=>f.preview_url)?.preview_url || null
            };
            inferred = true;
            console.log('🧩 Inferred Printful variant for checkout:', variantId);
          } catch (e) {
            console.warn('⚠️ Could not infer variantId for Printful item:', e.message);
          }
        }
        if (!v) {
          // Fetch live variant details from Printful for server-side validation
          v = await fetchPrintfulVariantDetails(variantId);
        }
        const priceInCents = Math.max(1, Math.round((v.price || 0) * 100));
        line_items.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: v.name || item.name || 'Catfish Empire Product',
              images: v.image_url ? [v.image_url] : (item.image ? [item.image] : []),
              metadata: {
                printful_variant_id: String(variantId || ''),
                external_id: item.external_id ? String(item.external_id) : undefined
              }
            },
            unit_amount: priceInCents
          },
          quantity: item.qty || 1
        });
      } else {
        // Sunglasses product - use existing hardcoded pricing
        line_items.push({
          price_data: {
            currency: "usd",
            product_data: { name: `Catfish Empire™ ${item.color} Sunglasses` },
            unit_amount: 1499,
          },
          quantity: item.qty,
        });
      }
    }

    const onlyPrintful = items.every((it) => it.type === 'printful');
    const shippingOptions = onlyPrintful
      ? [
          {
            shipping_rate_data: {
              type: "fixed_amount",
              fixed_amount: { amount: 0, currency: "usd" },
              display_name: "Free Shipping",
            },
          },
        ]
      : [
          {
            shipping_rate_data: {
              type: "fixed_amount",
              fixed_amount: { amount: 599, currency: "usd" },
              display_name: "Flat Rate Shipping",
            },
          },
        ];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items,
      metadata: {
        items: JSON.stringify(items),
        shippingState: shippingState || "Unknown",
      },
      shipping_address_collection: { allowed_countries: ["US"] },
      automatic_tax: { enabled: true },
      shipping_options: shippingOptions,
      success_url: `${process.env.CLIENT_URL}/success.html`,
      cancel_url: `${process.env.CLIENT_URL}/cart.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Checkout failed" });
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

    const items = JSON.parse(session.metadata?.items || "[]");
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
    for (const item of items) {
      if (item.type === 'printful') {
        // Printful products - just log for notification
        updated.push(`${item.qty} × ${item.name} (Printful) - $${item.price}`);
      } else if (inventory[item.color] !== undefined) {
        // Sunglasses products - update inventory
        inventory[item.color] -= item.qty;
        await updateQuantity(item.color, inventory[item.color]);
        updated.push(`${item.qty} × ${item.color} Sunglasses - $14.99`);
      }
    }

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

💰 Total: $${items.reduce((sum, item) => {
  const price = item.type === 'printful' ? item.price : 14.99;
  return sum + (price * item.qty);
}, 0).toFixed(2)} + $5.99 shipping + tax
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

    console.log("✅ Inventory updated from payment");
  }

  res.json({ received: true });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 4242; // Render injects PORT
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
