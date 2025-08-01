require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1); // for secure cookies behind proxy (Render, etc.)

// ===== Raw body for Stripe Webhooks =====
app.post("/webhook", express.raw({ type: "application/json" }));

// ===== JSON + URL Encoded Body Parsing (after webhook setup) =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Session Configuration =====
app.use(session({
  secret: process.env.SESSION_SECRET || "changeme",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,         // true = HTTPS only
    httpOnly: true,
    sameSite: "none"      // required for cross-site cookies
  }
}));

// ===== CORS Configuration =====
app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));

// ===== Supabase Setup =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== In-Memory Inventory Cache =====
let inventory = {};

// ===== Load Inventory from Supabase =====
async function loadInventory() {
  const { data, error } = await supabase
    .from("inventory")
    .select("color, quantity");
  if (error) throw error;
  const inv = {};
  data.forEach(i => inv[i.color.trim()] = i.quantity);
  return inv;
}

async function updateQuantity(color, qty) {
  const { error } = await supabase
    .from("inventory")
    .update({ quantity: qty })
    .eq("color", color);
  if (error) throw error;
}

// ===== Initial Load =====
loadInventory().then(inv => {
  inventory = inv;
  console.log("Inventory loaded:", inventory);
}).catch(err => console.error("Failed to load inventory", err));

// ===== Public Endpoint =====
app.get("/public-inventory", async (req, res) => {
  try {
    const inv = await loadInventory();
    inventory = inv;
    res.json(inv);
  } catch (err) {
    res.json(inventory);
  }
});

// ===== Admin-Only: Get Inventory =====
app.get("/inventory", async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  try {
    const inv = await loadInventory();
    inventory = inv;
    res.json(inv);
  } catch (err) {
    res.status(500).json({ error: "Failed to load inventory" });
  }
});

// ===== Login =====
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

// ===== Logout =====
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ===== Update Inventory =====
app.post("/inventory", async (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  const { color, qty } = req.body;
  const qtyInt = parseInt(qty, 10);
  try {
    await updateQuantity(color, qtyInt);
    inventory[color] = qtyInt;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update inventory" });
  }
});

// ===== Stripe Checkout =====
app.post("/create-checkout-session", async (req, res) => {
  const { items } = req.body;

  // Validate inventory
  try {
    const colors = items.map(i => i.color);
    const { data, error } = await supabase
      .from("inventory")
      .select("color, quantity")
      .in("color", colors);
    if (error) throw error;

    for (const item of items) {
      const match = data.find(d => d.color === item.color);
      if (!match || item.qty > match.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${item.color}` });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: "Inventory validation failed" });
  }

  // Create Stripe session
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: items.map(item => ({
        price: item.priceId,
        quantity: item.qty,
      })),
      success_url: `${process.env.CLIENT_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel.html`,
      metadata: { items: JSON.stringify(items) },
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Stripe session creation failed" });
  }
});

// ===== Stripe Webhook =====
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
    const items = JSON.parse(session.metadata.items || "[]");

    for (const item of items) {
      try {
        const { data: row, error } = await supabase
          .from("inventory")
          .select("quantity")
          .eq("color", item.color)
          .single();
        if (error) throw error;
        const newQty = Math.max((row?.quantity || 0) - item.qty, 0);
        await updateQuantity(item.color, newQty);
        inventory[item.color] = newQty;
      } catch (err) {
        console.error(`Error updating inventory for ${item.color}`, err);
      }
    }
  }

  res.json({ received: true });
});

// ===== Start Server =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
