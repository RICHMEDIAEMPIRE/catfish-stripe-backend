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

// Global cache for store_id
let cachedStoreId = null;

// Clear cached store ID (useful for debugging or error recovery)
const clearStoreIdCache = () => {
  console.log("🗑️ Clearing cached store ID");
  cachedStoreId = null;
};

// Get Printful store ID (cached)
const getPrintfulStoreId = async () => {
  if (cachedStoreId) {
    console.log(`🎯 Using cached store ID: ${cachedStoreId}`);
    return cachedStoreId;
  }

  console.log("🔍 Fetching store information from /store endpoint...");
  
  try {
    const storeResponse = await fetch('https://api.printful.com/store', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });

    const storeData = await storeResponse.json();
    
    if (!storeResponse.ok) {
      console.error(`❌ Printful store API error: ${storeResponse.status} - ${JSON.stringify(storeData)}`);
      throw new Error(`Failed to fetch store information: ${storeResponse.status} - ${storeData?.error?.message || 'Unknown error'}`);
    }

    console.log("🏪 Store data fetched successfully:", JSON.stringify(storeData, null, 2));
    
    // Check if store data has the expected structure
    if (!storeData.result || !storeData.result.id) {
      console.error("❌ Invalid store data structure:", storeData);
      throw new Error('Store ID not found in API response. Expected result.id field.');
    }
    
    cachedStoreId = storeData.result.id;
    console.log(`✅ Successfully cached store ID: ${cachedStoreId}`);
    
    return cachedStoreId;
    
  } catch (error) {
    console.error("❌ Error fetching store ID:", error.message);
    // Reset cached store ID on error
    cachedStoreId = null;
    throw new Error(`Unable to retrieve store ID: ${error.message}`);
  }
};

// Centralized Printful products fetch function with OAuth 2.0 Bearer token
const fetchPrintfulProducts = async () => {
  try {
    console.log("🚀 Starting Printful products fetch...");
    
    // Get store ID dynamically
    const storeId = await getPrintfulStoreId();
    
    if (!storeId) {
      throw new Error('Store ID is missing or invalid');
    }

    console.log(`📡 Fetching products from store ID: ${storeId}`);
    
    // Now fetch products from the specific store
    const response = await fetch(`https://api.printful.com/stores/${storeId}/products`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Catfish Empire Server'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`❌ Products fetch failed: ${response.status} - ${JSON.stringify(data)}`);
      throw new Error(`Printful products API error: ${response.status} - ${data?.error?.message || 'Unknown error'}`);
    }

    console.log(`✅ Successfully fetched products. Status: ${response.status}, Code: ${data.code}`);
    console.log("🛒 Raw Printful product data:", JSON.stringify(data, null, 2));
    
    // Validate response structure
    if (data.code !== 200) {
      console.error(`❌ API returned error code: ${data.code} - ${data.error || 'Unknown error'}`);
      throw new Error(`Printful API error code: ${data.code} - ${data.error || 'Unknown error'}`);
    }
    
    return data;
  } catch (err) {
    console.error('❌ Printful fetch error:', err.message);
    console.error('❌ Full error details:', err);
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

    // Get store ID for detailed product fetches
    const storeId = await getPrintfulStoreId();

    // Process up to 12 products to avoid overwhelming the page
    for (const product of products.slice(0, 12)) {
      try {
        // Fetch detailed product information
        const detailResponse = await fetch(`https://api.printful.com/stores/${storeId}/products/${product.id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${printfulApiKey}`,
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
    console.log("🔍 Fetching Printful products from Catfish Empire section...");
    
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

    // Use the centralized fetch function
    const productsData = await fetchPrintfulProducts();

    if (productsData.code !== 200) {
      throw new Error(`Printful API error: ${productsData.error || 'Unknown error'}`);
    }

    const allProducts = productsData.result || [];
    console.log(`📦 Found ${allProducts.length} total Printful products`);
    
    // Return all products without filtering - let frontend handle it
    const enrichedProducts = [];

    // Get store ID for detailed product fetches
    const storeId = await getPrintfulStoreId();

    // Process up to 20 products from all products
    for (const product of allProducts.slice(0, 20)) {
      try {
        console.log(`🔄 Processing product: ${product.name} (ID: ${product.id})`);
        
        // Fetch detailed product information
        const detailResponse = await fetch(`https://api.printful.com/stores/${storeId}/products/${product.id}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${printfulApiKey}`,
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
              // Collect all mockup images from all variants
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

              // Remove duplicates based on URL
              const uniqueImages = allMockupImages.filter((img, index, self) =>
                index === self.findIndex(i => i.url === img.url)
              );

              const enrichedProduct = {
                id: product.id,
                productId: product.id,
                name: productDetail.sync_product?.name || product.name || 'Catfish Empire Product',
                description: productDetail.sync_product?.description || 'Premium Catfish Empire merchandise',
                price: parseFloat(variant.retail_price),
                currency: variant.currency || 'USD',
                variantId: variant.id,
                variant_id: variant.id, // Keep both for compatibility
                availability: variant.availability_status || 'active',
                type: 'printful',
                images: uniqueImages,
                thumbnail: uniqueImages[0]?.thumbnail || uniqueImages[0]?.url || '',
                mainImage: uniqueImages[0]?.url || '',
                freeShipping: true, // All Printful items have free shipping as requested
                section: 'All Products'
              };

              console.log(`✅ Enriched product: ${enrichedProduct.name} with ${enrichedProduct.images.length} images`);
              enrichedProducts.push(enrichedProduct);
            }
          }
        }

        // Rate limiting - small delay between requests
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (error) {
        console.warn(`⚠️ Failed to fetch details for product ${product.id}:`, error.message);
      }
    }

    const responseData = {
      products: enrichedProducts,
      count: enrichedProducts.length,
      timestamp: now,
      section: 'All Products'
    };

    console.log(`🎯 Returning ${enrichedProducts.length} enriched products`);

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
