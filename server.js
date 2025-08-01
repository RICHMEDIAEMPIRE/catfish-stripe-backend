require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);

// Stripe Webhook must come before body parsing
app.post("/webhook", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "changeme",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: "none"
  }
}));

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));

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

loadInventory().then(inv => {
  inventory = inv;
  console.log("✅ Inventory loaded:", inventory);
}).catch(err => console.error("❌ Failed to load inventory", err));

// ===== Public Inventory Endpoint =====
app.get("/public-inventory", async (req, res) => {
  try {
    const inv = await loadInventory();
    inventory = inv;
    res.json(inv);
  } catch (err) {
    res.json(inventory);
  }
});

// ===== Admin Inventory Access =====
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

app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid password" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

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

// ===== Stripe Checkout with fixed price_data =====
app.post("/create-checkout-session", async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid cart format" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: items.map(item => ({
        price_data: {
          currency: "usd",
          product_data: {
            name: `Catfish Empire™ ${item.color} Sunglasses`
          },
          unit_amount: 1499
        },
        quantity: item.qty
      })),
      success_url: `${process.env.CLIENT_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Stripe session creation failed" });
  }
});

// ===== Webhook: Update Inventory =====
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

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });

      for (const item of lineItems.data) {
        const match = item.description.match(/^(\w+) Sunglasses$/i);
        if (match) {
          const color = match[1].trim();
          const purchasedQty = item.quantity;

          if (color && inventory[color] !== undefined) {
            const newQty = inventory[color] - purchasedQty;
            await updateQuantity(color, newQty);
            inventory[color] = newQty;
            console.log(`🕶️ ${color} inventory updated to ${newQty}`);
          } else {
            console.warn(`⚠️ Unknown color: "${color}"`);
          }
        }
      }
    } catch (err) {
      console.error("❌ Failed to update inventory from webhook:", err);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});
