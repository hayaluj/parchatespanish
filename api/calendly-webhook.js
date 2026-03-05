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

function getClassType(str) {
  if (!str) return null;
  const s = str.toLowerCase();
  if (s.includes('individual')) return 'individual';
  if (s.includes('group') || s.includes('a1')) return 'group';
  if (s.includes('parche') || s.includes('new-meeting')) return 'parche';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const buf = await buffer(req);
  const body = JSON.parse(buf.toString());

  const signature = req.headers['calendly-webhook-signature'];
  if (process.env.CALENDLY_WEBHOOK_SECRET && signature) {
    const hmac = crypto.createHmac('sha256', process.env.CALENDLY_WEBHOOK_SECRET);
    hmac.update(buf);
    const digest = hmac.digest('hex');
    if (digest !== signature) return res.status(401).send('Invalid signature');
  }

  const event = body.event;
  const payload = body.payload;

  const scheduledEventName = payload?.scheduled_event?.name || '';
  const scheduledEventUri = payload?.scheduled_event?.uri || '';
  const trackingStr = JSON.stringify(payload?.tracking || {});
  console.log('Event:', event, '| scheduled_event.name:', scheduledEventName, '| tracking:', trackingStr);

  const classType = getClassType(scheduledEventName)
    || getClassType(scheduledEventUri)
    || getClassType(trackingStr);

  if (event === 'invitee.created') {
    const email = (payload?.email || '').toLowerCase();
    const scheduledAt = payload?.scheduled_event?.start_time;
    const eventUri = payload?.scheduled_event?.uri;
    const eventId = eventUri?.split('/').pop();

    console.log('Booking - email:', email, 'classType:', classType);

    if (!email || !classType) {
      console.log('Missing email or classType - email:', email, 'classType:', classType, 'scheduledEventName:', scheduledEventName);
      return res.status(200).json({ received: true });
    }

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

    await supabase.from('credits').update({
      credits_remaining: credits.credits_remaining - 1,
    }).eq('student_email', email).eq('class_type', classType);

    await supabase.from('bookings').insert({
      student_email: email,
      class_type: classType,
      calendly_event_id: eventId,
      calendly_event_uri: eventUri,
      scheduled_at: scheduledAt,
      status: 'active',
    });

    console.log('Credit deducted for', email, classType);

  } else if (event === 'invitee.canceled') {
    const email = (payload?.email || '').toLowerCase();
    const eventUri = payload?.scheduled_event?.uri;
    const eventId = eventUri?.split('/').pop();

    console.log('Cancellation - email:', email, 'classType:', classType);

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

      await supabase.from('bookings').update({ status: 'cancelled' })
        .eq('calendly_event_id', eventId);

      console.log('Credit refunded for', email, classType);
    }
  }

  res.status(200).json({ received: true });
}
