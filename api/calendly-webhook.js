const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Map Calendly event type URIs to class types
const CALENDLY_TYPE_MAP = {
  'parchate-spanish-individual-class': 'individual',
  'parchate-spanish-group-classes-a1': 'group',
  'new-meeting': 'parche',
};

function getClassType(eventTypeSlug) {
  for (const [key, value] of Object.entries(CALENDLY_TYPE_MAP)) {
    if (eventTypeSlug.includes(key)) return value;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const buf = await buffer(req);
  const body = JSON.parse(buf.toString());

  // Verify Calendly webhook signature
  const signature = req.headers['calendly-webhook-signature'];
  if (process.env.CALENDLY_WEBHOOK_SECRET && signature) {
    const hmac = crypto.createHmac('sha256', process.env.CALENDLY_WEBHOOK_SECRET);
    hmac.update(buf);
    const digest = hmac.digest('hex');
    if (digest !== signature) {
      return res.status(401).send('Invalid signature');
    }
  }

  const event = body.event;
  const payload = body.payload;

  if (event === 'invitee.created') {
    // A booking was made — deduct 1 credit
    const email = payload?.email?.toLowerCase();
    const eventTypeSlug = payload?.event_type?.slug || '';
    const classType = getClassType(eventTypeSlug);
    const scheduledAt = payload?.scheduled_event?.start_time;
    const eventUri = payload?.scheduled_event?.uri;
    const eventId = eventUri?.split('/').pop();

    if (!email || !classType) {
      console.log('Unknown event type or missing email:', eventTypeSlug, email);
      return res.status(200).json({ received: true });
    }

    // Check current credits
    const { data: credits } = await supabase
      .from('credits')
      .select('credits_remaining')
      .eq('student_email', email)
      .eq('class_type', classType)
      .single();

    if (!credits || credits.credits_remaining <= 0) {
      console.log('No credits for', email, classType);
      return res.status(200).json({ received: true });
    }

    // Deduct 1 credit
    await supabase.from('credits').update({
      credits_remaining: credits.credits_remaining - 1,
    }).eq('student_email', email).eq('class_type', classType);

    // Record the booking
    await supabase.from('bookings').insert({
      student_email: email,
      class_type: classType,
      calendly_event_id: eventId,
      calendly_event_uri: eventUri,
      scheduled_at: scheduledAt,
      status: 'active',
    });

  } else if (event === 'invitee.canceled') {
    // A booking was cancelled — refund 1 credit
    const email = payload?.email?.toLowerCase();
    const eventUri = payload?.scheduled_event?.uri;
    const eventId = eventUri?.split('/').pop();
    const eventTypeSlug = payload?.event_type?.slug || '';
    const classType = getClassType(eventTypeSlug);

    if (email && classType) {
      const { data: credits } = await supabase
        .from('credits')
        .select('credits_remaining')
        .eq('student_email', email)
        .eq('class_type', classType)
        .single();

      if (credits) {
        await supabase.from('credits').update({
          credits_remaining: credits.credits_remaining + 1,
        }).eq('student_email', email).eq('class_type', classType);
      }

      // Mark booking as cancelled
      await supabase.from('bookings').update({ status: 'cancelled' })
        .eq('calendly_event_id', eventId);
    }
  }

  res.status(200).json({ received: true });
}
