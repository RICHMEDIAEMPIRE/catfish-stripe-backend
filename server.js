// ===== ENV & CORE =====
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

// Scraper deps (install: npm i cheerio node-fetch@2)
const cheerio = require("cheerio");
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
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
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
// ============= ETSY SECTION SCRAPER (RSS + optional gallery) =========
// =====================================================================
const ETSY_SECTION_URL =
  "https://www.etsy.com/shop/RICHMEDIAEMPIRE?ref=profile_header&sort_order=price_asc&section_id=54071039";
const ETSY_RSS_URL = "https://www.etsy.com/shop/RICHMEDIAEMPIRE/rss";

let ETSY_CACHE = { data: null, ts: 0 };
const ETSY_TTL_MS = 15 * 60 * 1000; // 15 minutes

// When SCRAPERAPI_KEY is set, we route page fetches through it to avoid 403.
function buildProxyUrl(target) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return null;
  const base = "https://api.scraperapi.com/";
  const params = new URLSearchParams({
    api_key: key,
    url: target,
    render: "true",          // render JS if Etsy needs it
    country_code: "us",      // US pages
    keep_headers: "true"
  });
  return `${base}?${params.toString()}`;
}

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://www.etsy.com/",
  "upgrade-insecure-requests": "1",
};

app.get("/etsy/section", cors(), async (req, res) => {
  try {
    const bypassCache = "nocache" in req.query;
    if (!bypassCache && ETSY_CACHE.data && Date.now() - ETSY_CACHE.ts < ETSY_TTL_MS) {
      return res.json(ETSY_CACHE.data);
    }

    // 1) Pull RSS (reliable titles/links/prices/cover image when present)
    const rssText = await (await fetch(ETSY_RSS_URL, { headers: BROWSER_HEADERS })).text();
    const $x = cheerio.load(rssText, { xmlMode: true });

    const items = [];
    $x("item").each((_, it) => {
      const title = $x(it).find("title").first().text().trim();
      let url = $x(it).find("link").first().text().trim();
      url = url.split("?")[0].split("#")[0];

      const priceNs =
        $x(it).find("g\\:price").first().text().trim() ||
        $x(it).find("etsy\\:price").first().text().trim() ||
        "";
      const desc = $x(it).find("description").first().text() || "";
      const descPrice = (desc.match(/\$\s?\d+(?:[\.,]\d{2})?/) || [""])[0];

      const imgCandidates = new Set();
      const mediaUrl =
        $x(it).find("media\\:content").attr("url") ||
        $x(it).find("media\\:thumbnail").attr("url") ||
        $x(it).find("enclosure").attr("url") ||
        $x(it).find("g\\:image_link").first().text().trim() ||
        "";
      if (mediaUrl) imgCandidates.add(mediaUrl);

      const contentEncoded = $x(it).find("content\\:encoded").first().text();
      if (contentEncoded) {
        const $c = cheerio.load(contentEncoded);
        $c("img").each((_, img) => {
          const src = $c(img).attr("src");
          if (src) imgCandidates.add(src);
        });
      }

      const cover = Array.from(imgCandidates)
        .map((u) => {
          if (!u) return "";
          if (u.startsWith("//")) return "https:" + u;
          if (u.startsWith("/")) return "https://www.etsy.com" + u;
          return u.replace(/^http:\/\//i, "https://");
        })
        .find(Boolean);

      if (/\/listing\/\d+/.test(url)) {
        items.push({
          url,
          title: title || "Etsy Listing",
          price: priceNs || descPrice || "",
          images: cover ? [cover] : [], // one safe image without hitting listing page
        });
      }
    });

    // Fallback: section page for URLs if RSS empty
    if (items.length === 0) {
      const html = await (await fetch(ETSY_SECTION_URL, { headers: BROWSER_HEADERS })).text();
      const $ = cheerio.load(html);
      const set = new Set();
      $('a[href*="/listing/"]').each((_, a) => {
        let href = $(a).attr("href") || "";
        href = href.split("?")[0].split("#")[0];
        if (href.startsWith("//")) href = "https:" + href;
        if (href.startsWith("/")) href = "https://www.etsy.com" + href;
        if (/^https?:\/\/(www\.)?etsy\.com\/listing\/\d+/.test(href)) set.add(href);
      });
      for (const url of Array.from(set)) {
        items.push({ url, title: "Etsy Listing", price: "", images: [] });
      }
    }

    // 2) OPTIONAL: Augment each listing with gallery images
    // Only if you provided SCRAPERAPI_KEY; otherwise we keep the cover image.
    async function augmentListing(listing) {
      const proxied = buildProxyUrl(listing.url);
      if (!proxied) return listing; // no proxy key, skip

      try {
        const pageRes = await fetch(proxied, { headers: BROWSER_HEADERS });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const page = await pageRes.text();
        const $ = cheerio.load(page);

        const gallery = new Set(listing.images);
        let title = listing.title;
        let price = listing.price;

        // JSON-LD
        $('script[type="application/ld+json"]').each((_, s) => {
          try {
            const raw = $(s).contents().text() || "{}";
            const json = JSON.parse(raw);
            const nodes = Array.isArray(json) ? json : [json];
            for (const n of nodes) {
              const t = n && n["@type"];
              const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product"));
              if (!isProduct) continue;

              if (!title && n.name) title = String(n.name);
              const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
              if (!price && offer) {
                if (offer.price) price = `$${offer.price}`;
                else if (offer.priceSpecification?.price) {
                  const cur = offer.priceSpecification.priceCurrency || "$";
                  price = `${cur} ${offer.priceSpecification.price}`;
                }
              }
              const arr = Array.isArray(n.image) ? n.image : n.image ? [n.image] : [];
              arr.forEach((u) => gallery.add(String(u)));
            }
          } catch {}
        });

        // OG + link rel=image_src
        $('meta[property="og:image"], meta[property="og:image:secure_url"]').each((_, m) => {
          const u = $(m).attr("content");
          if (u) gallery.add(u);
        });
        $('link[rel="image_src"]').each((_, l) => {
          const u = $(l).attr("href");
          if (u) gallery.add(u);
        });

        // srcset + img src
        function addSrcset(val) {
          if (!val) return;
          val.split(",").forEach((part) => {
            const u = part.trim().split(" ")[0];
            if (u) gallery.add(u);
          });
        }
        $("source[srcset]").each((_, s) => addSrcset($(s).attr("srcset")));
        $("img[srcset]").each((_, s) => addSrcset($(s).attr("srcset")));
        $("img").each((_, img) => {
          const u = $(img).attr("src") || $(img).attr("data-src") || "";
          if (u) gallery.add(u);
        });

        // Normalize/dedupe/cap
        const outImgs = Array.from(gallery)
          .map((u) => {
            if (!u) return "";
            if (u.startsWith("//")) u = "https:" + u;
            if (u.startsWith("/")) u = "https://www.etsy.com" + u;
            return u.replace(/^http:\/\//i, "https://");
          })
          .filter(Boolean);

        return {
          url: listing.url,
          title: title || listing.title || "Etsy Listing",
          price: price || listing.price || "",
          images: Array.from(new Set(outImgs)).slice(0, 12),
        };
      } catch (e) {
        console.warn("augmentListing failed:", listing.url, e.message);
        return listing; // keep RSS cover
      }
    }

    const useProxy = !!process.env.SCRAPERAPI_KEY;
    let out = items;
    if (useProxy) {
      out = [];
      const BATCH = 3;
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH).map(augmentListing);
        const results = await Promise.all(batch);
        out.push(...results);
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    ETSY_CACHE = { data: out, ts: Date.now() };
    res.json(out);
  } catch (e) {
    console.error("Etsy scrape failed:", e);
    res.status(500).json({ error: "Etsy scrape failed" });
  }
});

// =====================================================================
// ====================== PRINTFUL API INTEGRATION ====================
// =====================================================================

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

// ====================== PUBLIC PRODUCTS ROUTE ========================
// GET /products/printful/:section → returns enriched products
app.get('/products/printful/:section', cors(), async (req, res) => {
  try {
    const section = String(req.params.section || '').toLowerCase();
    console.log('🛍️  Products request for section:', section);

    const productsData = await fetchPrintfulProducts();
    if (productsData.code !== 200) {
      return res.status(500).json({ error: productsData.error || 'Failed to fetch products' });
    }

    const allProducts = productsData.result || [];
    console.log(`📦 Fetched ${allProducts.length} raw products from Printful`);

    // Enrich products with details and images
    const enrichedProducts = [];
    for (const product of allProducts.slice(0, 20)) {
      try {
        const detailResponse = await fetch(`https://api.printful.com/store/products/${product.id}`, {
          method: 'GET',
          headers: {
            'Authorization': getPrintfulAuthHeader(),
            'Content-Type': 'application/json',
            'User-Agent': 'Catfish-Empire/1.0'
          }
        });

        if (detailResponse.ok) {
          const detailData = await detailResponse.json();
          if (detailData.code === 200 && detailData.result) {
            const productDetail = detailData.result;
            const variant = productDetail.sync_variants && productDetail.sync_variants[0];

            if (variant && variant.retail_price && parseFloat(variant.retail_price) > 0) {
              const allMockupImages = [];
              productDetail.sync_variants?.forEach(v => {
                v.files?.forEach(file => {
                  if (file.type === 'preview' && file.preview_url) {
                    allMockupImages.push({
                      url: file.preview_url,
                      thumbnail: file.thumbnail_url || file.preview_url,
                      title: `${productDetail.sync_product?.name} - ${v.name || 'Variant'}`
                    });
                  }
                });
              });

              const uniqueImages = allMockupImages.filter((img, index, self) => index === self.findIndex(i => i.url === img.url));

              enrichedProducts.push({
                id: product.id,
                productId: product.id,
                name: productDetail.sync_product?.name || product.name || 'Catfish Empire Product',
                description: productDetail.sync_product?.description || 'Premium Catfish Empire merchandise',
                price: parseFloat(variant.retail_price),
                currency: variant.currency || 'USD',
                variantId: variant.id,
                variant_id: variant.id,
                availability: variant.availability_status || 'active',
                type: 'printful',
                images: uniqueImages,
                thumbnail: uniqueImages[0]?.thumbnail || uniqueImages[0]?.url || '',
                mainImage: uniqueImages[0]?.url || '',
                freeShipping: true,
                section
              });
            }
          }
        }

        await new Promise(r => setTimeout(r, 120));
      } catch (e) {
        console.warn(`⚠️ Enrich failed for product ${product.id}:`, e.message);
      }
    }

    console.log(`🎯 Returning ${enrichedProducts.length} enriched products for section '${section}'`);
    return res.json({ products: enrichedProducts, count: enrichedProducts.length, section });
  } catch (error) {
    console.error('❌ /products/printful/:section error:', error);
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

// Get Printful store ID (cached) - tries /stores first, then /store?store_id if needed
const getPrintfulStoreId = async () => {
  if (cachedStoreId) {
    console.log(`🎯 Using cached store ID: ${cachedStoreId}`);
    return cachedStoreId;
  }

  console.log("🔍 Fetching store information (trying /stores)...");
  
  try {
    // First try the multi-store listing endpoint
    const listResp = await fetch('https://api.printful.com/stores', {
      method: 'GET',
      headers: {
        'Authorization': getPrintfulAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });
    const listJson = await listResp.json().catch(() => ({}));
    if (listResp.ok && Array.isArray(listJson.result) && listJson.result.length > 0) {
      cachedStoreId = listJson.result[0].id;
      console.log(`✅ Cached store ID from /stores: ${cachedStoreId}`);
      return cachedStoreId;
    }

    // If /stores is not available or empty, try /store?store_id fallback if env provides one
    console.warn('⚠️ /stores did not return a usable store. If your token requires explicit store_id, set PRINTFUL_STORE_ID in env.');
    if (process.env.PRINTFUL_STORE_ID) {
      cachedStoreId = process.env.PRINTFUL_STORE_ID;
      console.log(`✅ Using PRINTFUL_STORE_ID from env: ${cachedStoreId}`);
      return cachedStoreId;
    }

    // Last resort: call /store without id to get precise error for logs
    const storeResponse = await fetch('https://api.printful.com/store', {
      method: 'GET',
      headers: {
        'Authorization': getPrintfulAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });
    const storeData = await storeResponse.json().catch(() => ({}));
    console.error(`❌ Printful /store response (no id): ${storeResponse.status} - ${JSON.stringify(storeData)}`);
    throw new Error('No store_id available. Set PRINTFUL_STORE_ID or use a token scoped to a default store.');
    
  } catch (error) {
    console.error("❌ Error fetching store ID:", error.message);
    // Reset cached store ID on error
    cachedStoreId = null;
    throw new Error(`Unable to retrieve store ID: ${error.message}`);
  }
};

// Centralized Printful products fetch function with OAuth 2.0 Bearer token
const fetchPrintfulProducts = async () => {
  const requestInfo = {
    url: 'https://api.printful.com/store/products',
    method: 'GET',
    headers: {
      Authorization: 'Bearer ***', // sanitized (actual header built below)
      'Content-Type': 'application/json',
      'User-Agent': 'Catfish Empire Server'
    }
  };

  try {
    console.log('🚀 Starting Printful products fetch...');
    console.log('🌐 Request:', { url: requestInfo.url, method: requestInfo.method, headers: requestInfo.headers });

    // First attempt without store_id (works for tokens bound to a default store)
    let response = await fetch(requestInfo.url, {
      method: requestInfo.method,
      headers: {
        Authorization: getPrintfulAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': requestInfo.headers['User-Agent']
      }
    });
    let text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // If API requires store_id, fetch it and retry with ?store_id=
    if (response.status === 400 && typeof data === 'object' && /store_id/i.test(JSON.stringify(data))) {
      const storeId = await getPrintfulStoreId();
      const urlWithId = `${requestInfo.url}?store_id=${encodeURIComponent(storeId)}`;
      console.log('🔁 Retrying products fetch with store_id:', urlWithId);
      response = await fetch(urlWithId, {
        method: requestInfo.method,
        headers: {
          Authorization: getPrintfulAuthHeader(),
          'Content-Type': 'application/json',
          'User-Agent': requestInfo.headers['User-Agent']
        }
      });
      text = await response.text();
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    if (!response.ok) {
      console.error('❌ Products fetch failed', {
        status: response.status,
        statusText: response.statusText,
        url: requestInfo.url,
        method: requestInfo.method,
        response: data
      });
      throw new Error(`Printful products API error: ${response.status} - ${JSON.stringify(data)}`);
    }

    console.log(`✅ Products fetched. Status: ${response.status}`);
    if (data && typeof data === 'object') {
      console.log('🛒 Raw Printful product data:', JSON.stringify(data, null, 2));
    }

    if (data.code !== 200) {
      console.error('❌ API returned non-200 code', { code: data.code, error: data.error });
      throw new Error(`Printful API error code: ${data.code} - ${data.error || 'Unknown error'}`);
    }

    return data;
  } catch (err) {
    console.error('❌ Printful fetch error:', err.message);
    throw err;
  }
};

// Printful API endpoint to fetch synced products
app.get("/printful/products", cors(), async (req, res) => {
  try {
    const printfulApiKey = process.env.PRINTFUL_API_KEY;
    if (!printfulApiKey) {
      return res.status(500).json({ error: "Printful API key not configured" });
    }

    // Cache for Printful products (15 minute TTL)
    const cacheKey = 'printful_products';
    const now = Date.now();
    
    // Simple in-memory cache (could be Redis in production)
    if (!global.printfulCache) global.printfulCache = {};
    
    if (global.printfulCache[cacheKey] && 
        (now - global.printfulCache[cacheKey].timestamp) < (15 * 60 * 1000)) {
      return res.json(global.printfulCache[cacheKey].data);
    }

    // Use the centralized fetch function
    const productsData = await fetchPrintfulProducts();
    
    if (productsData.code !== 200) {
      throw new Error(`Printful API error: ${productsData.error || 'Unknown error'}`);
    }

    const products = productsData.result || [];
    const enrichedProducts = [];

    // Process up to 12 products to avoid overwhelming the page
    for (const product of products.slice(0, 12)) {
      try {
        // Fetch detailed product information
        const detailResponse = await fetch(`https://api.printful.com/store/products/${product.id}`, {
          method: 'GET',
          headers: {
            'Authorization': getPrintfulAuthHeader(),
            'Content-Type': 'application/json',
            'User-Agent': 'Catfish-Empire/1.0'
          }
        });

        if (detailResponse.ok) {
          const detailData = await detailResponse.json();
          if (detailData.code === 200 && detailData.result) {
            const productDetail = detailData.result;
            const variant = productDetail.sync_variants && productDetail.sync_variants[0];

            if (variant && variant.retail_price) {
              enrichedProducts.push({
                id: product.id,
                name: productDetail.sync_product?.name || product.name || 'Catfish Empire Product',
                description: productDetail.sync_product?.description || 'Premium Catfish Empire merchandise',
                price: parseFloat(variant.retail_price),
                currency: variant.currency || 'USD',
                image: variant.files?.[0]?.preview_url || variant.files?.[0]?.thumbnail_url || '',
                variant_id: variant.id,
                availability: variant.availability_status || 'active',
                type: 'printful'
              });
            }
          }
        }

        // Rate limiting - small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.warn(`Failed to fetch details for product ${product.id}:`, error);
      }
    }

    const responseData = {
      products: enrichedProducts,
      count: enrichedProducts.length,
      timestamp: now
    };

    // Cache the results
    global.printfulCache[cacheKey] = {
      data: responseData,
      timestamp: now
    };

    res.json(responseData);
  } catch (error) {
    console.error('Printful products fetch error:', error);
    res.status(500).json({ 
      error: "Failed to fetch Printful products",
      details: error.message 
    });
  }
});

// Enhanced Printful API endpoint for "Catfish Empire" section with detailed product info
app.get("/api/printful-products", cors(), async (req, res) => {
  try {
    const sectionParam = String(req.query.section || '').trim().toLowerCase();
    console.log("🔍 /api/printful-products called. section=", sectionParam || '(none)');
    
    const printfulApiKey = process.env.PRINTFUL_API_KEY;
    if (!printfulApiKey) {
      console.error("❌ Printful API key not configured");
      return res.status(500).json({ error: "Printful API key not configured" });
    }
    
    // Debug API key (safely)
    console.log(`🔑 API Key found - Length: ${printfulApiKey.length}, Starts with: ${printfulApiKey.substring(0, 8)}...`);
    
    // Test authentication first with a simple API call
    console.log("🧪 Testing Printful API authentication...");
    const authTestResponse = await fetch('https://api.printful.com/oauth/scopes', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${printfulApiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish-Empire/1.0'
      }
    });
    
    console.log(`🔍 Auth test status: ${authTestResponse.status}`);
    if (!authTestResponse.ok) {
      const authError = await authTestResponse.text();
      console.error(`❌ Printful auth test failed: ${authTestResponse.status} - ${authError}`);
      return res.status(401).json({ 
        error: "Printful API authentication failed", 
        status: authTestResponse.status,
        details: "You need a new OAuth 2.0 Bearer token from https://developers.printful.com/ - Basic authentication is deprecated"
      });
    }
    
    console.log("✅ Printful authentication successful!");

    // Cache for enhanced Printful products (15 minute TTL)
    const cacheKey = 'all_printful_products';
    const now = Date.now();
    
    if (!global.printfulCache) global.printfulCache = {};
    
    if (global.printfulCache[cacheKey] && 
        (now - global.printfulCache[cacheKey].timestamp) < (15 * 60 * 1000)) {
      console.log("✅ Using cached Printful products");
      return res.json(global.printfulCache[cacheKey].data);
    }

    // Direct call to Printful list endpoint as requested
    let listResp = await fetch('https://api.printful.com/store/products', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${printfulApiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish-Empire/1.0'
      }
    });
    let text = await listResp.text();
    let productsData; try { productsData = JSON.parse(text); } catch { productsData = { raw: text }; }
    console.log("Printful response:", JSON.stringify(productsData, null, 2));

    // Retry with store_id if required
    if (listResp.status === 400 && /store_id/i.test(JSON.stringify(productsData))) {
      const storeId = await getPrintfulStoreId();
      const url = `https://api.printful.com/store/products?store_id=${encodeURIComponent(storeId)}`;
      console.log('🔁 Retrying list with store_id:', url);
      listResp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${printfulApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Catfish-Empire/1.0'
        }
      });
      text = await listResp.text();
      try { productsData = JSON.parse(text); } catch { productsData = { raw: text }; }
      console.log("Printful response (with store_id):", JSON.stringify(productsData, null, 2));
    }

    if (!listResp.ok) {
      return res.status(listResp.status).json({ error: 'Printful list error', details: productsData });
    }

    let allProducts = Array.isArray(productsData.result) ? productsData.result : [];
    console.log(`📦 Found ${allProducts.length} total Printful products`);

    // If a section is provided, attempt a simple name-based filter.
    // Note: Printful product templates don't include a native "section" field;
    // this filter matches product names/descriptions to the provided section token.
    if (sectionParam) {
      // For accurate filtering, fetch details and check sync_product.name
      const filtered = [];
      const normalizedSection = sectionParam.replace(/-/g, ' ').trim();
      const matchedNames = [];
      for (const p of allProducts) {
        try {
          const dResp = await fetch(`https://api.printful.com/store/products/${p.id}`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${printfulApiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Catfish-Empire/1.0'
            }
          });
          if (!dResp.ok) continue;
          const dJson = await dResp.json();
          const nameRaw = dJson?.result?.sync_product?.name || '';
          const nmLower = nameRaw.toLowerCase();
          if (nmLower && nmLower.includes(normalizedSection)) {
            filtered.push(p);
            matchedNames.push(nameRaw);
          }
          await new Promise(r => setTimeout(r, 60));
        } catch (_) {}
      }
      allProducts = filtered;
      console.log('✅ Matched product names:', matchedNames);
      console.log(`🎯 Returning ${allProducts.length} enriched products for section '${sectionParam}'`);
    }

    // Return products without further enrichment per simplified spec
    // Optionally also log matched product names
    const namesSample = allProducts.slice(0, 10).map(p => p.name || p.id);
    console.log('🧾 Names sample:', namesSample);

    const responseData = {
      products: allProducts,
      count: allProducts.length,
      timestamp: now,
      section: sectionParam || ''
    };

    console.log(`🎯 Returning ${responseData.count} products for section '${responseData.section || '(all)'}'`);

    // Cache the results
    global.printfulCache[cacheKey] = {
      data: responseData,
      timestamp: now
    };

    res.json(responseData);
  } catch (error) {
    console.error('❌ Catfish Empire Printful fetch error:', error);
    res.status(500).json({ 
      error: "Failed to fetch Catfish Empire Printful products",
      details: error.message 
    });
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

// ===== STRIPE CHECKOUT =====
app.post("/create-checkout-session", async (req, res) => {
  const { items, shippingState } = req.body;
  if (!items || !Array.isArray(items))
    return res.status(400).json({ error: "Invalid cart format" });

  try {
    // Create line items with dynamic pricing based on product type
    const line_items = items.map((item) => {
      if (item.type === 'printful') {
        // Printful product - use dynamic pricing
        const priceInCents = Math.round((item.price || 0) * 100);
        return {
          price_data: {
            currency: item.currency?.toLowerCase() || "usd",
            product_data: { 
              name: item.name || 'Catfish Empire Product',
              images: item.image ? [item.image] : []
            },
            unit_amount: priceInCents,
          },
          quantity: item.qty || 1,
        };
      } else {
        // Sunglasses product - use existing hardcoded pricing
        return {
          price_data: {
            currency: "usd",
            product_data: { name: `Catfish Empire™ ${item.color} Sunglasses` },
            unit_amount: 1499,
          },
          quantity: item.qty,
        };
      }
    });

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
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 599, currency: "usd" },
            display_name: "Flat Rate Shipping",
          },
        },
      ],
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
