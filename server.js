/*
 * Updated Node.js backend for Catfish Empire
 *
 * This version persists inventory to Supabase and ensures quantities
 * survive server restarts. It also decrements inventory in Supabase
 * whenever a Stripe checkout completes successfully via webhook.
 *
 * To use this file, install the @supabase/supabase-js package with:
 *   npm install @supabase/supabase-js
 * and set the following environment variables in your .env file:
 *   SUPABASE_URL=your-supabase-url
 *   SUPABASE_SERVICE_KEY=your-service-role-key
 *   STRIPE_SECRET_KEY=sk_test_xxx
 *   STRIPE_WEBHOOK_SECRET=whsec_xxx
 *   SESSION_SECRET=some-random-string
 *
 * Replace the existing server.js with this file or rename it to
 * server.js before deploying.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
// Use a service key (service role) so the server can read and write
// without rowâ€‘level security restrictions. Do NOT expose this key to
// the browser.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.set("trust proxy", 1);

// ===== RAW BODY FOR WEBHOOKS (MUST COME FIRST) =====
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ===== SESSION SETUP =====
app.use(
  session({
    secret: process.env.SESSION_SECRET || "changeme",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

// ===== CORS =====
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  })
);

// ===== HELPER: Load inventory from Supabase =====
async function loadInventory() {
  const { data, error } = await supabase
    .from("inventory")
    .select("color, quantity");
  if (error) throw error;
  const inv = {};
  data.forEach((item) => {
    inv[item.color] = item.quantity;
  });
  return inv;
}

// ===== HELPER: Update quantity in Supabase =====
async function updateQuantity(color, qty) {
  // qty should be an integer
  const { error } = await supabase
    .from("inventory")
    .update({ quantity: qty })
    .eq("color", color);
  if (error) throw error;
}

// ===== Inâ€‘memory cache for inventory =====
let inventory = {};
// Load inventory at startup
loadInventory()
  .then((inv) => {
    inventory = inv;
    console.log("Inventory loaded", inventory);
  })
  .catch((err) => {
    console.error("Failed to load inventory from Supabase", err);
  });

// ===== PUBLIC ENDPOINT: Get inventory =====
app.get("/public-inventory", async (req, res) => {
  try {
    const inv = await loadInventory();
    return res.json(inv);
  } catch (err) {
    console.error(err);
    // Fallback to cached inventory if Supabase call fails
    return res.json(inventory);
  }
});

// ===== AUTHENTICATED INVENTORY ENDPOINT =====
app.get("/inventory", async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  try {
    const inv = await loadInventory();
    return res.json(inv);
  } catch (err) {
    console.error(err);
    return res.json(inventory);
  }
});

// ===== LOGIN =====
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Invalid password" });
});

// ===== LOGOUT =====
app.post("/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== UPDATE INVENTORY =====
app.post("/inventory", async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  const { color, qty } = req.body;
  const qtyInt = parseInt(qty, 10);
  try {
    await updateQuantity(color, qtyInt);
    inventory[color] = qtyInt; // update cache
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update inventory" });
  }
});

// ===== CREATE CHECKOUT SESSION =====
app.post("/create-checkout-session", async (req, res) => {
  const { items } = req.body;
  // Verify each requested item quantity against Supabase
  try {
    const colors = items.map((i) => i.color);
    const { data: stockData, error: fetchError } = await supabase
      .from("inventory")
      .select("color, quantity")
      .in("color", colors);
    if (fetchError) throw fetchError;
    for (const item of items) {
      const row = stockData.find((r) => r.color === item.color);
      if (!row || item.qty > row.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${item.color}` });
      }
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Inventory lookup failed" });
  }
  // Build the line items for Stripe; adjust price IDs as needed.
  const lineItems = items.map((item) => ({
    price: item.priceId,
    quantity: item.qty,
  }));
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: lineItems,
      success_url: `${process.env.CLIENT_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel.html`,
      metadata: { items: JSON.stringify(items) },
    });
    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create Stripe session" });
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
    console.error("Webhook signature verification failed", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const items = JSON.parse(session.metadata.items || "[]");
    for (const item of items) {
      try {
        // Fetch current quantity from Supabase
        const { data: row, error: fetchErr } = await supabase
          .from("inventory")
          .select("quantity")
          .eq("color", item.color)
          .single();
        if (fetchErr) throw fetchErr;
        const newQty = Math.max((row?.quantity || 0) - item.qty, 0);
        await updateQuantity(item.color, newQty);
        inventory[item.color] = newQty;
      } catch (err) {
        console.error(`Failed to decrement inventory for ${item.color}`, err);
      }
    }
  }
  res.json({ received: true });
});

// ===== START THE SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
