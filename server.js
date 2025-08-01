require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

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
  const { data, error } = await supabase.from("inventory").select("color, quantity");
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

loadInventory().then(inv => inventory = inv);

// ===== EMAIL SETUP =====
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ===== SESSION & CORS =====
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "changeme",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: "none" }
}));

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
  if (!req.session.authenticated) return res.status(403).json({ error: "Not logged in" });
  const inv = await loadInventory();
  inventory = inv;
  res.json(inv);
});

app.post("/inventory", async (req, res) => {
  if (!req.session.authenticated) return res.status(403).json({ error: "Not logged in" });
  const { color, qty } = req.body;
  const qtyInt = parseInt(qty, 10);
  await updateQuantity(color, qtyInt);
  inventory[color] = qtyInt;
  res.json({ success: true });
});

// ===== STRIPE CHECKOUT ($0.50 Pricing, No Shipping) =====
app.post("/create-checkout-session", async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: "Invalid cart format" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_creation: "always",
      line_items: items.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: `Catfish Empire™ ${item.color} Sunglasses` },
          unit_amount: 50
        },
        quantity: item.qty
      })),
      metadata: { items: JSON.stringify(items) },
      automatic_tax: { enabled: true },
      success_url: `${process.env.CLIENT_URL}/success.html`,
      cancel_url: `${process.env.CLIENT_URL}/cart.html`
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
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const items = JSON.parse(session.metadata?.items || "[]");

    // ⬇️ Fix for missing shipping/email
    const shipping =
      session.shipping?.address ||
      session.collected_information?.shipping_details?.address || {};
    const name =
      session.shipping?.name ||
      session.collected_information?.shipping_details?.name || "unknown";
    const email =
      session.customer_email ||
      session.customer_details?.email ||
      "unknown";

    let updated = [];
    for (const item of items) {
      if (inventory[item.color] !== undefined) {
        inventory[item.color] -= item.qty;
        await updateQuantity(item.color, inventory[item.color]);
        updated.push(`${item.qty} x ${item.color}`);
      }
    }

    const message = `New Order:

Ship To:
${name}
${shipping.line1 || "—"}
${shipping.city || "—"}, ${shipping.state || "—"} ${shipping.postal_code || "—"}

Email: ${email}

Items:
${updated.join("\n")}`;

    transporter.sendMail({
      from: `"Catfish Empire" <${process.env.SMTP_USER}>`,
      to: "rich@richmediaempire.com",
      subject: "New Order Received",
      text: message
    }, err => {
      if (err) console.error("❌ Email failed:", err);
      else console.log("📨 Order email sent");
    });

    console.log("✅ Inventory updated from payment");
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
