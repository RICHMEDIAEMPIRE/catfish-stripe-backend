// server.js
const express = require("express");
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors = require("cors");
require("dotenv").config();

app.use(cors());
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const items = req.body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided." });
    }

    const totalQty = items.reduce((sum, item) => sum + item.qty, 0);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Catfish Empire™ Sunglasses",
            },
            unit_amount: 1499, // $14.99 in cents
          },
          quantity: totalQty,
        },
      ],
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 599, // $5.99 shipping
              currency: "usd",
            },
            display_name: "Standard Shipping",
          },
        },
      ],
      automatic_tax: { enabled: true },
      success_url: "https://catfishempire.com/success",
      cancel_url: "https://catfishempire.com/cart.html",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe Error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

const PORT = 4242;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
