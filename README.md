# AI Phone Lead Capture MVP (Node.js)

A simple inbound voice lead capture system for small businesses.

## What this MVP does

- Answers incoming phone calls (via Twilio webhooks)
- Keeps conversation short and friendly
- Captures:
  - Name
  - Phone number
  - Service requested
- Confirms captured details
- Outputs structured lead data
- Suggests next action (`standard_callback`, `priority_callback`, `manual_review`)

## Architecture (MVP)

- **Twilio Voice** receives incoming calls and calls your webhook endpoints
- **Fastify server** runs call state machine and validation
- **In-memory storage** stores leads (replace later with Postgres/CRM)
- **Lead API** exposes structured captures at `GET /api/leads`

## Files

- `server.js` - Voice webhook handlers + call flow + lead capture
- `.env.example` - Required configuration values
- `package.json` - Project dependencies and scripts

## Prerequisites

- Node.js 18+
- Twilio account + phone number
- Public URL for local dev (e.g. ngrok)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from example:

   ```bash
   cp .env.example .env
   ```

3. Fill in `.env` values.

4. Start server:

   ```bash
   npm run dev
   ```

5. Expose local server publicly (example with ngrok):

   ```bash
   ngrok http 3000
   ```

6. In Twilio phone number config, set webhook URLs:
   - **A call comes in** → `POST https://YOUR_PUBLIC_URL/voice/incoming`

## Call flow

1. Greeting + ask what caller needs
2. Capture service requested
3. Capture name
4. Capture phone number (normalized to E.164 when possible)
5. Confirm details (yes/no)
6. Store structured lead + suggest next action
7. Close call with callback expectation

## API

### Health check

```http
GET /health
```

### List captured leads

```http
GET /api/leads
```

Response example:

```json
{
  "count": 1,
  "leads": [
    {
      "callId": "CA123...",
      "timestamp": "2026-04-05T15:00:00.000Z",
      "businessName": "Acme Home Services",
      "callerPhoneRaw": "+15551234567",
      "lead": {
        "name": "Jane Doe",
        "phone": "+15551234567",
        "serviceRequested": "Water heater repair",
        "intentSummary": "Water heater repair"
      },
      "suggestedNextAction": {
        "type": "priority_callback",
        "reason": "Urgent request detected"
      }
    }
  ]
}
```

## Known MVP limitations

- In-memory storage (data resets on restart)
- No auth on API endpoints
- No real CRM integration yet
- Basic yes/no confirmation only
- No transfer-to-human flow yet

## Next improvements

- Postgres persistence + migrations
- CRM webhook integration
- Better entity extraction with LLM structured output
- SMS callback confirmation
- Dashboard UI
- Multi-tenant business support
