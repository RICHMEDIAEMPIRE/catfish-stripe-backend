require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  const { items } = req.body;

  const subtotal = items.reduce((total, item) => {
    return total + item.quantity * 14.99;
  }, 0);

  const shipping = 5.99;
  const tax = (subtotal + shipping) * 0.07;
  const total = (subtotal + shipping + tax) * 100;

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Catfish Empire™ Sunglasses',
        },
        unit_amount: Math.round(total),
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: 'https://catfishempire.com/success',
    cancel_url: 'https://catfishempire.com/cancel',
  });

  res.json({ url: session.url });
});

app.listen(4242, () => console.log('Server running on port 4242'));
