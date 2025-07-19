require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();

// Trust Render's reverse proxy to handle secure cookies properly
app.set('trust proxy', 1);

// In-memory inventory
let inventory = {
  Blue: 10,
  Green: 10,
  Red: 10,
  Silver: 10,
  Black: 10,
  Brown: 10
};

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.use(cors({
  origin: "https://test1243.netlify.app",
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "mysecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "none",  // Required for cross-origin cookies
    secure: true       // Required because we're using HTTPS on Render
  }
}));

// ====== AUTH ======

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Unauthorized" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ====== INVENTORY ======

app.get("/inventory", (req, res) => {
  console.log("[GET INVENTORY] Session:", req.session);
  if (!req.session.authenticated) {
    return res.status(403).json({ error: "Not logged in" });
  }
  res.json(inventory);
});

app.post("/inventory", (req, res) => {
  console.log("[POST INVENTORY] Session:", req.session);
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
      quantity: item.qty
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
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
      success_url: "https://catfishempire.com/success.html",
      cancel_url: "https://catfishempire.com/cart.html"
    });

    // Deduct inventory after session created
    items.forEach(item => {
      inventory[item.color] -= item.qty;
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
