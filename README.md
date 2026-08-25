# AI Chat API

Backend API cho AI Chat UI — built với **Hono** + **Cloudflare Workers** + **D1** + **Qdrant** + **Google Gemini**.

## Live Demo

🔗 **https://ai-chat-api.ai-chat-api.workers.dev**

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Cloudflare Workers | Edge serverless functions |
| Framework | Hono | Lightweight web framework |
| Database | Cloudflare D1 | Serverless SQLite |
| Vector DB | Qdrant | Vector search for RAG |
| AI | Google Gemini API | LLM inference + embeddings |

## Architecture

```
Client (Next.js)
      ↓
Cloudflare Workers (Hono)
      ├── D1 Database (conversations, messages, eval, safety)
      ├── Qdrant (vector embeddings)
      └── Google Gemini API (AI responses + embeddings)
```

## API Endpoints

### Health Check
```
GET /
```
Response: `{ "status": "ok", "service": "ai-chat-api" }`

### Conversations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/conversations` | List all conversations |
| `POST` | `/api/conversations` | Create new conversation |
| `GET` | `/api/conversations/:id` | Get conversation with messages |
| `PUT` | `/api/conversations/:id` | Update conversation title |
| `DELETE` | `/api/conversations/:id` | Delete conversation and messages |

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/messages/chat` | Send message & get AI response (SSE) |
| `PUT` | `/api/messages/:id/feedback` | Update feedback (thumbs up/down) |

### RAG (Retrieval-Augmented Generation)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rag/documents` | List uploaded documents |
| `POST` | `/api/rag/documents` | Upload & embed document |
| `DELETE` | `/api/rag/documents/:id` | Delete document |
| `POST` | `/api/rag/query` | RAG query (SSE streaming) |

### Multi-Agent Orchestrator

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/orchestrator/run` | Run multi-agent workflow (SSE) |
| `GET` | `/api/orchestrator/agents` | List available agents |
| `POST` | `/api/orchestrator/approve` | Approve pending task |
| `POST` | `/api/orchestrator/reject` | Reject pending task |

### Eval Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/eval/metrics` | Get aggregated metrics |
| `GET` | `/api/eval/metrics/timeseries` | Get metrics time series |
| `GET` | `/api/eval/runs` | List eval runs |
| `POST` | `/api/eval/runs` | Create eval run |
| `PUT` | `/api/eval/runs/:id/complete` | Complete eval run |
| `GET` | `/api/eval/runs/:id/results` | Get run results |
| `POST` | `/api/eval/runs/:id/results` | Add eval result |
| `GET` | `/api/eval/failures` | Get failure cases |
| `GET` | `/api/eval/models` | Get unique model versions |

### Safety Gates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/safety/gates` | List safety gates |
| `POST` | `/api/safety/gates` | Create safety gate |
| `PUT` | `/api/safety/gates/:id` | Update safety gate |
| `GET` | `/api/safety/check/:runId` | Check gates for eval run |
| `GET` | `/api/safety/approvals` | List deploy approvals |
| `POST` | `/api/safety/approvals` | Create approval request |
| `PUT` | `/api/safety/approvals/:id` | Approve/Reject deploy |

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Google Gemini API key ([get one here](https://aistudio.google.com/apikey))
- Qdrant Cloud account ([get one here](https://qdrant.io))

### Installation

```bash
npm install
```

### Create D1 Database

```bash
npx wrangler d1 create ai-chat-db
```

Copy `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ai-chat-db"
database_id = "YOUR_DATABASE_ID"
```

### Initialize Schema

```bash
# Local development
npm run db:init

# Production (remote)
npm run db:init:remote
```

### Set Environment Variables

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
```

### Development

```bash
npm run dev
# Server runs at http://localhost:8787
```

### Deploy

```bash
npm run deploy
```

## Database Schema

```sql
-- Conversations & Messages
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, sources TEXT, feedback_rating TEXT, feedback_comment TEXT, created_at TEXT);

-- Documents for RAG
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, url TEXT, chunk_count INTEGER, created_at TEXT);

-- Eval Metrics
CREATE TABLE eval_runs (id TEXT PRIMARY KEY, model_version TEXT, prompt_variant TEXT, status TEXT, total_cases INTEGER, passed_cases INTEGER, failed_cases INTEGER, avg_latency_ms REAL, avg_cost_usd REAL, started_at TEXT, completed_at TEXT);
CREATE TABLE eval_results (id TEXT PRIMARY KEY, run_id TEXT, query TEXT, expected_output TEXT, actual_output TEXT, score REAL, passed INTEGER, latency_ms REAL, cost_usd REAL, feedback_rating TEXT, feedback_comment TEXT, hallucination_flag INTEGER, metadata TEXT, created_at TEXT);

-- Safety Gates
CREATE TABLE safety_gates (id TEXT PRIMARY KEY, name TEXT, metric TEXT, threshold REAL, enabled INTEGER, created_at TEXT);
CREATE TABLE deploy_approvals (id TEXT PRIMARY KEY, eval_run_id TEXT, status TEXT, approved_by TEXT, comment TEXT, created_at TEXT, resolved_at TEXT);
```

## Features

### Chat
- **AI Chat**: Proxy to Google Gemini API with system prompt
- **Streaming SSE**: Token-by-token responses
- **Conversation Management**: CRUD operations on conversations
- **Message Persistence**: Save all messages to D1
- **Feedback System**: Thumbs up/down on assistant messages
- **Auto-retry**: Retry with fallback models on overload

### RAG (Retrieval-Augmented Generation)
- **Document Upload**: Upload and embed documents
- **Vector Search**: Qdrant for similarity search
- **Gemini Embeddings**: text-embedding-004 (3072 dimensions)
- **Streaming RAG**: Token-by-token with source citations

### Multi-Agent Orchestrator
- **Planner Agent**: Analyzes requests, breaks into tasks
- **Designer Agent**: Creates design specs (layout, colors, typography)
- **Coder Agent**: Generates React/TypeScript code
- **Reviewer Agent**: Reviews code for accessibility, performance
- **Human-in-the-loop**: Approve/reject tasks before execution
- **Exponential Backoff**: Retry logic for rate limits (429)

### Eval Dashboard
- **Metrics Aggregation**: Accuracy, latency, cost, hallucination rate
- **Time Series**: Metrics over time visualization
- **Failure Cases**: Query, expected/actual output, feedback analysis
- **Safety Gates**: Automatic deploy blocking if metrics degrade
- **Deploy Approvals**: Human-in-the-loop deployment decisions

## Models

| Model | Purpose | Notes |
|-------|---------|-------|
| `gemini-3.6-flash` | Chat + Agents | Primary model |
| `gemini-2.0-flash-lite` | Fallback | Lighter, more available |
| `gemini-embedding-004` | Embeddings | 3072 dimensions |

## Project Structure

```
ai-chat-api/
├── src/
│   ├── index.ts                  # Hono app + CORS + routes
│   ├── types.ts                  # TypeScript types
│   ├── types/
│   │   ├── agents.ts             # Agent type definitions
│   │   └── eval.ts               # Eval type definitions
│   ├── routes/
│   │   ├── conversations.ts      # Conversation CRUD
│   │   ├── messages.ts           # Chat + feedback (SSE)
│   │   ├── rag.ts                # RAG documents + query
│   │   ├── orchestrator.ts       # Multi-agent workflow
│   │   ├── eval.ts               # Eval metrics + runs
│   │   └── safety.ts             # Safety gates + approvals
│   └── services/
│       ├── embedder.ts           # Gemini embeddings + chunking
│       ├── qdrant.ts             # Qdrant vector DB
│       └── agents/
│           ├── base-agent.ts     # Base agent class
│           ├── planner-agent.ts  # Planner agent
│           ├── designer-agent.ts # Designer agent
│           ├── coder-agent.ts    # Coder agent
│           ├── reviewer-agent.ts # Reviewer agent
│           ├── orchestrator.ts   # Workflow orchestration
│           └── index.ts          # Agent exports
├── schema.sql                    # D1 database schema
├── wrangler.toml                 # Cloudflare Workers config
├── .dev.vars                     # Local environment variables
└── package.json
```

## License

MIT
