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
// =============== ETSY SECTION SCRAPER (RSS + gallery) =================
// =====================================================================
const ETSY_SECTION_URL =
  "https://www.etsy.com/shop/RICHMEDIAEMPIRE?ref=profile_header&sort_order=price_asc&section_id=54071039";
const ETSY_RSS_URL = "https://www.etsy.com/shop/RICHMEDIAEMPIRE/rss";

let ETSY_CACHE = { data: null, ts: 0 };
const ETSY_TTL_MS = 15 * 60 * 1000; // 15 minutes

const REQ_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
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

    // 1) Pull RSS (reliable title/link/price/cover)
    const rssText = await (await fetch(ETSY_RSS_URL, { headers: REQ_HEADERS })).text();
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

      const imgs = new Set();
      const mediaUrl =
        $x(it).find("media\\:content").attr("url") ||
        $x(it).find("media\\:thumbnail").attr("url") ||
        $x(it).find("enclosure").attr("url") ||
        $x(it).find("g\\:image_link").first().text().trim() ||
        "";
      if (mediaUrl) imgs.add(mediaUrl);

      const contentEncoded = $x(it).find("content\\:encoded").first().text();
      if (contentEncoded) {
        const $c = cheerio.load(contentEncoded);
        $c("img").each((_, img) => {
          const src = $c(img).attr("src");
          if (src) imgs.add(src);
        });
      }

      const cover = Array.from(imgs)
        .map((u) => {
          if (!u) return "";
          if (u.startsWith("//")) return "https:" + u;
          if (u.startsWith("/")) return "https://www.etsy.com" + u;
          return u.replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull.");
        })
        .find(Boolean);

      if (/\/listing\/\d+/.test(url)) {
        items.push({
          url,
          title: title || "Etsy Listing",
          price: priceNs || descPrice || "",
          images: cover ? [cover] : [],
        });
      }
    });

    // Fallback: section page for URLs if RSS empty
    if (items.length === 0) {
      const html = await (await fetch(ETSY_SECTION_URL, { headers: REQ_HEADERS })).text();
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

    // 2) Augment each listing with gallery images
    async function augmentListing(listing) {
      try {
        const pageRes = await fetch(listing.url, { headers: REQ_HEADERS });
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
        const page = await pageRes.text();
        const $ = cheerio.load(page);

        const gallery = new Set(listing.images);
        let title = listing.title;
        let price = listing.price;

        // (a) JSON-LD Product
        $('script[type="application/ld+json"]').each((_, s) => {
          try {
            const raw = $(s).contents().text() || "{}";
            const json = JSON.parse(raw);
            const nodes = Array.isArray(json) ? json : [json];
            for (const n of nodes) {
              if (!n) continue;
              const t = n["@type"];
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
              arr.forEach((u) =>
                gallery.add(
                  String(u).replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull.")
                )
              );
            }
          } catch {}
        });

        // (b) OpenGraph & link rel=image_src
        $('meta[property="og:image"], meta[property="og:image:secure_url"]').each((_, m) => {
          const u = $(m).attr("content");
          if (u) gallery.add(u.replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull."));
        });
        $('link[rel="image_src"]').each((_, l) => {
          const u = $(l).attr("href");
          if (u) gallery.add(u.replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull."));
        });

        // (c) <picture><source srcset="..."> + <img srcset="...">
        function addSrcset(val) {
          if (!val) return;
          val.split(",").forEach((part) => {
            const u = part.trim().split(" ")[0];
            if (u && /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(u)) {
              gallery.add(u.replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull."));
            }
          });
        }
        $("source[srcset]").each((_, s) => addSrcset($(s).attr("srcset")));
        $("img[srcset]").each((_, s) => addSrcset($(s).attr("srcset")));

        // (d) Any remaining <img> with i.etsystatic.com or il_ pattern
        $("img").each((_, img) => {
          const u = $(img).attr("src") || $(img).attr("data-src") || "";
          if (/i\.etsystatic\.com/.test(u) || /il_[0-9]+x/.test(u) || /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(u)) {
            gallery.add(u.replace(/^http:\/\//i, "https://").replace(/il_\d+x\d+\./, "il_fullxfull."));
          }
        });

        return {
          url: listing.url,
          title: title || listing.title || "Etsy Listing",
          price: price || listing.price || "",
          images: Array.from(gallery).slice(0, 12),
        };
      } catch (e) {
        console.warn("augmentListing failed:", listing.url, e.message);
        return listing;
      }
    }

    const out = [];
    const urls = items.slice(0, 30); // safety cap
    const BATCH = 3;
    for (let i = 0; i < urls.length; i += BATCH) {
      const batch = urls.slice(i, i + BATCH).map(augmentListing);
      const resBatch = await Promise.all(batch);
      out.push(...resBatch);
    }

    ETSY_CACHE = { data: out, ts: Date.now() };
    res.json(out);
  } catch (e) {
    console.error("Etsy scrape failed:", e);
    res.status(500).json({ error: "Etsy scrape failed" });
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
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items: items.map((item) => ({
        price_data: {
          currency: "usd",
          product_data: { name: `Catfish Empire™ ${item.color} Sunglasses` },
          unit_amount: 1499,
        },
        quantity: item.qty,
      })),
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
      if (inventory[item.color] !== undefined) {
        inventory[item.color] -= item.qty;
        await updateQuantity(item.color, inventory[item.color]);
        updated.push(`${item.qty} × ${item.color}`);
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

🕶️ Items:
${updated.join("\n")}
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
const PORT = process.env.PORT || 4242; // Render injects PORT (e.g., 10000)
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
