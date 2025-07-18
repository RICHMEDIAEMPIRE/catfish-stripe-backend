const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  const { quantity } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Catfish Empire™ Polarized Sunglasses',
            },
            unit_amount: 1499,
          },
          quantity,
        },
      ],
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: 'Flat Rate Shipping',
            type: 'fixed_amount',
            fixed_amount: { amount: 599, currency: 'usd' },
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 5 },
            },
          },
        },
      ],
      automatic_tax: { enabled: true },
      success_url: 'https://catfishempire.com/success',
      cancel_url: 'https://catfishempire.com/cancel',
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
