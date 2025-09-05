// ===== ENV & CORE =====
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

// NEW: scraping deps for Etsy route
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
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
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

// ===== SIMPLE HEALTH CHECK =====
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// =====================================================================
// =============== ETSY SECTION SCRAPER (JSON-LD based) =================
// =====================================================================
// Update to your exact Etsy section URL if needed
const ETSY_SECTION_URL =
  "https://www.etsy.com/shop/RICHMEDIAEMPIRE?ref=profile_header&sort_order=price_asc&section_id=54071039";

// Simple in-memory cache so we don’t hammer Etsy
let ETSY_CACHE = { data: null, ts: 0 };
const ETSY_TTL_MS = 15 * 60 * 1000; // 15 minutes

app.get("/etsy/section", cors(), async (_req, res) => {
  try {
    if (ETSY_CACHE.data && Date.now() - ETSY_CACHE.ts < ETSY_TTL_MS) {
      return res.json(ETSY_CACHE.data);
    }

    // 1) Fetch the section page and collect listing URLs
    const html = await (
      await fetch(ETSY_SECTION_URL, { headers: { "user-agent": "Mozilla/5.0" } })
    ).text();
    const $ = cheerio.load(html);

    const urlSet = new Set();
    $('a[href*="/listing/"]').each((_, a) => {
      let href = $(a).attr("href") || "";
      if (!href) return;
      href = href.split("?")[0].split("#")[0];
      if (href.startsWith("//")) href = "https:" + href;
      if (href.startsWith("/")) href = "https://www.etsy.com" + href;
      if (/^https?:\/\/(www\.)?etsy\.com\/listing\/\d+/.test(href)) {
        urlSet.add(href);
      }
    });

    let listingUrls = Array.from(urlSet);

    // Fallback: shop RSS if nothing found (grabs ~10)
    if (listingUrls.length === 0) {
      const rssUrl = "https://www.etsy.com/shop/RICHMEDIAEMPIRE/rss";
      const rss = await (
        await fetch(rssUrl, { headers: { "user-agent": "Mozilla/5.0" } })
      ).text();
      const $$ = cheerio.load(rss, { xmlMode: true });
      $$("item > link").each((_, el) => {
        const href = $$(el).text().trim();
        if (href && /^https?:\/\/(www\.)?etsy\.com\/listing\/\d+/.test(href)) {
          listingUrls.push(href);
        }
      });
      listingUrls = Array.from(new Set(listingUrls));
    }

    // 2) Visit each listing and parse JSON-LD for title/price/images
    async function scrapeListing(url) {
      try {
        const page = await (
          await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })
        ).text();
        const $$ = cheerio.load(page);
        let title = "";
        let price = "";
        let images = [];

        $$('script[type="application/ld+json"]').each((_, s) => {
          try {
            const raw = $$(s).contents().text() || "{}";
            const json = JSON.parse(raw);
            const nodes = Array.isArray(json) ? json : [json];
            for (const node of nodes) {
              if (!node) continue;
              const type = node["@type"];
              const isProduct =
                type === "Product" ||
                (Array.isArray(type) && type.includes("Product"));
              if (!isProduct) continue;

              if (!title && node.name) title = String(node.name);

              if (!price) {
                const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
                if (offer) {
                  if (offer.price) price = `$${offer.price}`;
                  else if (offer.priceSpecification?.price) {
                    const cur = offer.priceSpecification.priceCurrency || "$";
                    price = `${cur} ${offer.priceSpecification.price}`;
                  }
                }
              }

              if (!images.length && node.image) {
                images = Array.isArray(node.image) ? node.image : [node.image];
              }
            }
          } catch {}
        });

        if (!images.length) {
          const seen = new Set();
          $$("img").each((_, img) => {
            const src = $$(img).attr("src") || $$(img).attr("data-src") || "";
            if (/\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(src)) {
              seen.add(src.replace(/il_\d+x\d+\./, "il_fullxfull."));
            }
          });
          images = Array.from(seen);
        }

        return { url, title: title || "Etsy Listing", price: price || "", images: images.slice(0, 12) };
      } catch (e) {
        console.error("Listing scrape failed:", url, e.message);
        return { url, title: "Etsy Listing", price: "", images: [] };
      }
    }

    // polite limited concurrency
    const out = [];
    const batchSize = 3;
    for (let i = 0; i < listingUrls.length; i += batchSize) {
      const batch = listingUrls.slice(i, i + batchSize).map(scrapeListing);
      const results = await Promise.all(batch);
      out.push(...results);
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
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
