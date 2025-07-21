require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();

app.set("trust proxy", 1);

// ====== RAW BODY FOR WEBHOOKS (MUST COME FIRST) ======
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ====== INVENTORY ======
let inventory = {
  Blue: 10,
  Green: 10,
  Red: 10,
  Silver: 10,
  Black: 10,
  Brown: 10
};

// ====== CONFIG ======
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ====== MIDDLEWARE ======
app.use(cors({
  origin: "https://catfishempire.com",
  credentials: true
}));

app.use(session({
  secret: process.env.SESSION_SECRET || "mysecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "none",
    secure: true
  }
}));

// ====== AUTH ======
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  console.warn("❌ Failed login attempt:", { username });
  res.status(401).json({ error: "Unauthorized" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ====== PUBLIC INVENTORY ======
app.get("/public-inventory", (req, res) => {
  res.json(inventory);
});

// ====== PROTECTED INVENTORY ======
app.get("/inventory", (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  res.json(inventory);
});

app.post("/inventory", (req, res) => {
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }

  const { color, qty } = req.body;
  if (!inventory.hasOwnProperty(color)) {
    return res.status(400).json({ error: "Invalid color" });
  }

  inventory[color] = parseInt(qty);
  res.json({ success: true });
});

// ====== STRIPE CHECKOUT ======
app.post("/create-checkout-session", async (req, res) => {
  try {
    const items = req.body.items;
    const receiptEmail = req.body.email;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items in request." });
    }

    for (const item of items) {
      if (!inventory[item.color] || item.qty > inventory[item.color]) {
        return res.status(400).json({ error: `Insufficient stock for ${item.color}` });
      }
    }

    const line_items = items.map(item => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: `Catfish Empire™ Sunglasses - ${item.color}`,
          images: ["https://catfishempire.com/your-sunglasses-image.jpg"]
        },
        unit_amount: 1499
      },
      quantity: item.qty || 1
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      metadata: {
        items: JSON.stringify(items),
        store_owner_email: "rich@richmediaempire.com"
      },
      shipping_address_collection: {
        allowed_countries: ['US']
      },
      customer_email: receiptEmail,
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 599, currency: "usd" },
            display_name: "Flat Rate Shipping"
          }
        }
      ],
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      success_url: "https://catfishempire.com/success.html",
      cancel_url: "https://catfishempire.com/cart.html"
    });

    console.log("✅ Stripe session created:", session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// ====== STRIPE WEBHOOK ======
app.post("/webhook", (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const metadata = session.metadata;

    if (metadata && metadata.items) {
      const items = JSON.parse(metadata.items);
      items.forEach(item => {
        if (inventory[item.color] !== undefined) {
          inventory[item.color] -= item.qty;
        }
      });

      console.log("✅ Inventory updated from Stripe webhook:", inventory);
      console.log("📦 Shipping address:", session.shipping?.address);
      console.log("📧 Customer email:", session.customer_email);
      console.log("📨 Send order to store owner:", metadata.store_owner_email);
    } else {
      console.warn("⚠️ No metadata.items found in webhook payload.");
    }
  }

  res.status(200).send("Received");
});

// ====== START SERVER ======
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
