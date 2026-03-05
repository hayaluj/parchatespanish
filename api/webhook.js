const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email?.toLowerCase();
    const productType = session.metadata?.productType || 'unknown';
    const amount = session.amount_total / 100;

    // Save purchase
    const { error } = await supabase.from('purchases').insert({
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent,
      stripe_customer_email: email,
      product_type: productType,
      amount_usd: amount,
    });
    if (error) console.error('Supabase insert error:', error);

    // Add credits based on product type
    const creditsMap = {
      individual:        { type: 'individual', credits: 1 },
      individual_5hr:    { type: 'individual', credits: 5 },
      individual_10hr:   { type: 'individual', credits: 10 },
      individual_15plus: { type: 'individual', credits: 15 },
      group:             { type: 'group',      credits: 1 },
      group_5hr:         { type: 'group',      credits: 5 },
      group_10hr:        { type: 'group',      credits: 10 },
      group_15plus:      { type: 'group',      credits: 15 },
      parche_pack:       { type: 'parche',     credits: 1 },
    };

    const creditInfo = creditsMap[productType];
    if (creditInfo && email) {
      // Check quantity for 15+ packs (extra hours stored in metadata)
      let creditsToAdd = creditInfo.credits;
      if (productType.includes('15plus') && session.metadata?.extraQuantity) {
        creditsToAdd = 15 + parseInt(session.metadata.extraQuantity);
      }
      if (productType === 'parche_pack' && session.metadata?.quantity) {
        creditsToAdd = parseInt(session.metadata.quantity);
      }

      // Upsert credits — add to existing balance
      const { data: existing } = await supabase
        .from('credits')
        .select('credits_remaining, credits_total')
        .eq('student_email', email)
        .eq('class_type', creditInfo.type)
        .single();

      if (existing) {
        await supabase.from('credits').update({
          credits_remaining: existing.credits_remaining + creditsToAdd,
          credits_total: existing.credits_total + creditsToAdd,
        }).eq('student_email', email).eq('class_type', creditInfo.type);
      } else {
        await supabase.from('credits').insert({
          student_email: email,
          class_type: creditInfo.type,
          credits_remaining: creditsToAdd,
          credits_total: creditsToAdd,
        });
      }
    }
  }

  res.status(200).json({ received: true });
}
