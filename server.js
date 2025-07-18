// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const quantity = req.body.quantity || 1;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Catfish Empire™ Sunglasses",
              images: ["https://catfishempire.com/your-sunglasses-image.jpg"],
            },
            unit_amount: 1499,
          },
          quantity,
        },
      ],
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 599, currency: "usd" },
            display_name: "Flat Rate Shipping",
          },
        },
      ],
      tax_id_collection: { enabled: true },
      success_url: "https://catfishempire.com/success.html",
      cancel_url: "https://catfishempire.com/cart.html",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
