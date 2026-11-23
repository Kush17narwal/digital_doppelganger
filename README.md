# Digital Doppelgänger

**Automata-Based Human vs Bot Behavioral Intelligence Platform**

A cybersecurity/behavioral-analysis platform that analyzes user interaction sequences in web applications and determines whether observed behavior is more consistent with a human-like or automated/scripted session. The core detection engine is built on **Automata Theory** — using finite state machines, product automata, and formal language recognition.

## Architecture

```
Frontend (Next.js / React / TypeScript / Tailwind CSS)
   ↓ HTTPS + Supabase Auth (anonymous user)
Supabase Edge Function (TypeScript)
   ↓
Supabase Postgres + Realtime
   ├── event processing and scoring
   ├── per-user sessions, events, states, detections
   └── realtime event stream to the browser
```

### Automata Engine

The system uses four specialized Deterministic Finite Automata combined via a product automaton:

1. **Navigation Automaton** — Tracks page transitions, back/forward navigation, repeated pages
2. **Interaction Automaton** — Tracks clicks, hovers, keyboard, scroll, form interactions
3. **Timing Automaton** — Tracks inter-event delays, rapid actions, timing regularity
4. **Consistency Automaton** — Tracks behavioral entropy, repetition, pattern diversity

**Product State** = Navigation × Interaction × Timing × Consistency

## Project Structure

```
digital_doppelganger/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI application
│   │   ├── config.py            # Configuration
│   │   ├── api/                 # REST & WebSocket endpoints
│   │   ├── models/              # SQLAlchemy models
│   │   ├── schemas/             # Pydantic schemas
│   │   ├── services/            # Business logic
│   │   ├── automata/            # Automata engine (core)
│   │   │   ├── base.py          # DFA base class & alphabet
│   │   │   ├── navigation.py    # Navigation DFA
│   │   │   ├── interaction.py   # Interaction DFA
│   │   │   ├── timing.py        # Timing DFA
│   │   │   ├── consistency.py   # Consistency DFA
│   │   │   └── product_automaton.py  # Product automaton
│   │   ├── detection/           # Scoring & classification
│   │   ├── simulation/          # Bot profiles
│   │   └── database/            # DB session management
│   ├── tests/                   # 30+ automated tests
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── app/                 # Next.js App Router pages
│   │   ├── components/          # Shared components
│   │   ├── hooks/               # Custom hooks
│   │   └── lib/                 # API client
│   ├── package.json
│   └── Dockerfile
├── supabase/
│   ├── config.toml
│   ├── functions/api/           # App API and automata processing
│   └── migrations/              # Tables, indexes, RLS, Realtime
└── backend/                     # Former FastAPI implementation, retained for reference
```

## Installation

### Local development

```bash
cd frontend
npm install
npm run dev
```

Copy `frontend/.env.example` to `frontend/.env.local` and fill in the Supabase project URL and public key. In Supabase Auth settings, enable **Anonymous Sign-Ins**.

### Deploy everything with Supabase + Vercel

There is no Render service in this deployment. Supabase runs the API in an Edge Function, stores data in Postgres, authenticates anonymous browser sessions, and streams live events through Realtime.

1. Create a Supabase project. In **Authentication → Sign In / Providers**, enable **Anonymous Sign-Ins**.
2. From the repository root, link the Supabase project and deploy its schema and API:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   supabase functions deploy api
   ```

3. In Vercel, open the frontend project's **Settings → Environment Variables** and set these for Production:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (legacy anon key also works) |

4. Redeploy the Vercel project. The browser signs in anonymously, calls the Supabase `api` Edge Function, and receives live event inserts over Supabase Realtime.

The Edge Function keeps the service-role credential server-side; the Vercel app only gets the public project key. Row Level Security isolates sessions and their events by the anonymous user's Supabase ID. The Python FastAPI directory is retained as the previous implementation and is not used by the Supabase/Vercel deployment.

#### Frontend environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | — |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key; legacy anon key also works | — |

## Running Tests

```bash
cd backend
pytest tests/ -v
```

## Running the Simulator

```bash
# Via API
curl -X POST http://localhost:8000/api/simulator/run \
  -H "Content-Type: application/json" \
  -d '{"profile": "scripted_bot", "event_count": 50}'
```

Or use the web interface at `/simulator`.

## Running Experiments

```bash
curl -X POST http://localhost:8000/api/experiments/run \
  -H "Content-Type: application/json" \
  -d '{"human_count": 100, "bot_count": 100, "adversarial_count": 100}'
```

Or use the web interface at `/analytics`.

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/dashboard` | Real-time monitoring dashboard |
| `/playground` | DoppelShop — interactive behavioral playground |
| `/simulator` | Bot simulation profiles |
| `/sessions` | Session explorer |
| `/sessions/[id]` | Session details with replay |
| `/compare` | Side-by-side session comparison |
| `/automata` | Automata Theory laboratory |
| `/attack-lab` | Adversarial testing lab |
| `/analytics` | Experiment dashboard |

## API Examples

### Create a session
```bash
curl -X POST http://localhost:8000/api/sessions
```

### Send an event
```bash
curl -X POST http://localhost:8000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "SESSION_ID",
    "event_type": "mouse_click",
    "timestamp": 1727651234.567,
    "page": "/products",
    "target": "add_to_cart"
  }'
```

### Get automata definitions
```bash
curl http://localhost:8000/api/automata/definitions
```

## Privacy

This is a behavioral analysis research platform. It does **not** collect passwords, payment information, personal messages, or unnecessary personally identifiable information. All sessions use anonymous UUIDs.

## Disclaimer

This system uses automata-based heuristics to assess behavioral patterns. It does **not** claim to definitively prove that a user is human or a bot. Results are labeled as "Human-like", "Automated-like", "Suspicious", or "Inconclusive" based on observed behavioral signals. Experiment results apply to synthetic test datasets only and do not establish real-world detection accuracy.
