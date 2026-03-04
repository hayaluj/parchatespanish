const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CALENDLY_URL = 'https://calendly.com/parchatespanish';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { priceId, quantity = 1, basePrice, extraPriceId, extraQuantity, productType } = req.body;

    let lineItems = [];

    // Custom quantity products (15+ packs, Parche Pack)
    if (basePrice && extraPriceId) {
      lineItems = [
        { price: basePrice, quantity: 1 },
      ];
      if (extraQuantity > 0) {
        lineItems.push({ price: extraPriceId, quantity: extraQuantity });
      }
    } else {
      lineItems = [{ price: priceId, quantity: parseInt(quantity) }];
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&type=${productType}`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/#prices`,
      metadata: { productType, calendly_url: CALENDLY_URL }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
};
