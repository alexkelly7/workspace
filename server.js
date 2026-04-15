const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

console.log('Supabase URL:', process.env.SUPABASE_URL);

const OpenAI = require('openai');
const fs = require('fs');
require('dotenv').config();

const Fastify = require('fastify');
const formbody = require('@fastify/formbody');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const app = Fastify({ logger: true });
app.register(formbody);

const PORT = Number(process.env.PORT || 3000);
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Local Business';
const CALLBACK_SLA = process.env.CALLBACK_SLA || 'soon';
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || 'US';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MVP in-memory store
const leads = [];
const callSessions = new Map();

app.post('/api/leads', async (req, res) => {
  const lead = req.body;

  const { data, error } = await supabase
    .from('leads')
    .insert([lead])
    .select();

  if (error) {
    console.error(error);
    return res.code(500).send({ error: 'Failed to save lead' });
  }

  res.send({ success: true, lead: data[0] });
});

//api process route
const callSid = req.body.CallSid;
const speech = String(req.body.SpeechResult || '').trim();

if (!callSessions.has(callSid)) {
  callSessions.set(callSid, {
    name: null,
    phone: null,
    problem: null
  });
}

const session = callSessions.get(callSid);
if (!session.problem) {
  session.problem = speech;
} else if (!session.name) {
  session.name = speech;
} else if (!session.phone) {
  session.phone = speech;
}
app.post('/api/voice/process', async (req, res) => {
  // Send user speech to OpenAI
  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: input: `You are an AI receptionist for a home service business.

You are collecting:
- problem
- name
- phone number

Current known info:
- Problem: ${session.problem || 'unknown'}
- Name: ${session.name || 'unknown'}
- Phone: ${session.phone || 'unknown'}

User just said: "${speech}"

Rules:
- Only ask for information that is still missing
- Do NOT ask for something you already have
- Be short and natural
- Once all 3 are collected, confirm and end the conversation

Respond naturally.`,
  });

  const aiText = response.output_text || "Sorry, I didn't catch that.";

  res.type('text/xml');
  res.send(`
    <Response>
      <Say voice="alice">
        ${aiText}
      </Say>
      <Gather input="speech" action="/api/voice/process" method="POST">
        <Say>Please continue.</Say>
      </Gather>
    </Response>
  `);
});

// Per-call session state (MVP)
const sessions = new Map();

function twimlSayGather(message, actionPath = '/voice/respond') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionPath}" method="POST" speechTimeout="auto" timeout="4">
    <Say>${message}</Say>
  </Gather>
  <Say>Sorry, I did not catch that.</Say>
  <Redirect method="POST">/voice/respond</Redirect>
</Response>`;
}

function twimlSayHangup(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${message}</Say>
  <Hangup/>
</Response>`;
}

function normalizePhone(raw) {
  if (!raw) return null;

  // Keep only digits and +
  const cleaned = raw.replace(/[^\d+]/g, '');
  const parsed = parsePhoneNumberFromString(cleaned, DEFAULT_COUNTRY);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

function suggestNextAction(lead) {
  const text = `${lead.lead.intentSummary || lead.lead.serviceRequested} ${lead.intentSummary || ''}`.toLowerCase();
  const urgentKeywords = ['urgent', 'emergency', 'asap', 'today', 'now'];
  const isUrgent = urgentKeywords.some((w) => text.includes(w));

  if (!lead.name || !lead.phone || !lead.serviceRequested) {
    return {
      type: 'manual_review',
      reason: 'Missing required lead fields'
    };
  }

  if (isUrgent || lead.aiUrgency === 'high') {
  return {
    type: 'priority_callback',
    reason: 'Urgent request detected'
  };
  }

  return {
    type: 'standard_callback',
    reason: 'Complete lead captured'
  };
}

function initializeSession(callSid, from) {
  sessions.set(callSid, {
    callSid,
    from,
    step: 'service',
    attempts: 0,
    lead: {
      name: null,
      phone: normalizePhone(from) || null,
      serviceRequested: null,
      intentSummary: null
    }
  });
}
async function analyzeLead(text) {
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL,
    input: `You are an extraction engine.

Read this customer request and return ONLY valid JSON.
Do not include markdown.
Do not include explanation.
Do not include code fences.

Customer request:
"${text}"

Return this exact shape:
{
  "serviceType": "plumbing | hvac | electrical | drain | unknown",
  "urgency": "low | medium | high",
  "summary": "short clean summary"
}`
  });
  const output = response.output_text;

  try {
    return JSON.parse(output);
  } catch {
    return {
      serviceType: "unknown",
      urgency: "medium",
      summary: text,
    };
  }
}
app.get('/health', async () => ({ status: 'ok' }));

// Twilio voice webhook for inbound call start
app.post('/api/voice/incoming', (req, res) => {
  res.type('text/xml');
  res.send(`
    <Response>
      <Gather
        input="speech"
        action="https://workspace-wn93.onrender.com/api/voice/process"
        method="POST"
        speechTimeout="auto"
        timeout="4"
        actionOnEmptyResult="true"
      >
        <Say voice="alice">
          Thanks for calling. Please tell me what you need help with today.
        </Say>
      </Gather>
      <Say voice="alice">
        Sorry, I did not hear anything. Please call back and try again.
      </Say>
      <Hangup />
    </Response>
  `);
});

// Twilio voice webhook for each gathered speech turn
app.post('/voice/respond', async (request, reply) => {
  const callSid = request.body.CallSid;
  const speech = String(request.body.SpeechResult || '').trim();

  if (!callSid || !sessions.has(callSid)) {
    reply.header('Content-Type', 'text/xml');
    return reply.send(twimlSayHangup('Sorry, your session expired. Please call back.'));
  }

  const session = sessions.get(callSid);

  if (!speech) {
    session.attempts += 1;
    if (session.attempts >= 2) {
      sessions.delete(callSid);
      reply.header('Content-Type', 'text/xml');
      return reply.send(twimlSayHangup('Sorry we could not hear you clearly. Please call again.'));
    }

    reply.header('Content-Type', 'text/xml');
    return reply.send(twimlSayGather('Sorry, I did not catch that. Could you repeat that?'));
  }

  session.attempts = 0;

  if (session.step === 'service') {
  session.lead.serviceRequested = speech;

  const analysis = await analyzeLead(speech);
  session.lead.intentSummary = analysis.summary;
  session.lead.serviceType = analysis.serviceType;
  session.lead.aiUrgency = analysis.urgency;

  session.step = 'name';

    reply.header('Content-Type', 'text/xml');
    return reply.send(twimlSayGather('Thanks. Can I get your name?'));
  }

  if (session.step === 'name') {
    session.lead.name = speech;
    session.step = 'phone';

    reply.header('Content-Type', 'text/xml');
    return reply.send(twimlSayGather('Great. What is the best phone number to reach you?'));
  }

  if (session.step === 'phone') {
    const normalized = normalizePhone(speech);
    if (!normalized) {
      session.attempts += 1;
      if (session.attempts >= 2) {
        session.step = 'confirm';
      } else {
        reply.header('Content-Type', 'text/xml');
        return reply.send(twimlSayGather('I had trouble with that number. Please say it again, including area code.'));
      }
    } else {
      session.lead.phone = normalized;
      session.step = 'confirm';
    }

    const confirmText = `Just to confirm, I have name ${session.lead.name || 'unknown'} and phone ${session.lead.phone || 'not captured'}. Is that correct? Please say yes or no.`;
    reply.header('Content-Type', 'text/xml');
    return reply.send(twimlSayGather(confirmText));
  }

  if (session.step === 'confirm') {
    const yes = /\b(yes|correct|right|yep)\b/i.test(speech);
    const no = /\b(no|wrong|incorrect|nope)\b/i.test(speech);

    if (no) {
      session.step = 'name';
      reply.header('Content-Type', 'text/xml');
      return reply.send(twimlSayGather('No problem. Let us try again. What is your name?'));
    }

    if (!yes) {
      reply.header('Content-Type', 'text/xml');
      return reply.send(twimlSayGather('Please say yes if correct, or no if you want to update it.'));
    }

    const record = {
      callId: session.callSid,
      timestamp: new Date().toISOString(),
      businessName: BUSINESS_NAME,
      callerPhoneRaw: session.from,
      lead: {
  name: session.lead.name,
  phone: session.lead.phone,
  serviceRequested: session.lead.serviceRequested,
  intentSummary: session.lead.intentSummary,
  serviceType: session.lead.serviceType,
  aiUrgency: session.lead.aiUrgency
}
};

    record.suggestedNextAction = suggestNextAction(record.lead);

    leads.push(record);
    sessions.delete(callSid);

    app.log.info({ lead: record }, 'Lead captured');

    reply.header('Content-Type', 'text/xml');
    return reply.send(
      twimlSayHangup(
        `Perfect, thanks. I have shared this with the team. You can expect a callback ${CALLBACK_SLA}.`
      )
    );
  }

  sessions.delete(callSid);
  reply.header('Content-Type', 'text/xml');
  return reply.send(twimlSayHangup('Thank you for calling. Goodbye.'));
});

app.get('/', async (request, reply) => {
  const html = fs.readFileSync('./index.html', 'utf-8');
  reply.type('text/html').send(html);
});
// API: list captured leads
app.get('/api/leads', async () => ({ count: leads.length, leads }));

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`Server listening on ${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
