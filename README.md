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

### Hybrid Search (Custom RAG)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/hybrid/documents` | Upload document with chunking strategy |
| `POST` | `/api/hybrid/search` | Hybrid search (BM25 + Vector + re-ranking) |
| `POST` | `/api/hybrid/query` | Full RAG query with hybrid search (SSE) |
| `POST` | `/api/hybrid/compare` | Compare search methods (vector vs BM25 vs hybrid) |
| `POST` | `/api/hybrid/evaluate` | Evaluate search quality with metrics |
| `POST` | `/api/hybrid/chunk` | Preview chunking strategies |
| `POST` | `/api/hybrid/ab-test` | Create A/B test |
| `POST` | `/api/hybrid/ab-test/:id/start` | Start A/B test |
| `POST` | `/api/hybrid/ab-test/:id/record` | Record A/B test result |
| `GET` | `/api/hybrid/ab-test/:id/summary` | Get A/B test summary |
| `GET` | `/api/hybrid/stats` | Get index statistics |

### Multi-Agent Orchestrator

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/orchestrator/run` | Run multi-agent workflow (SSE) |
| `GET` | `/api/orchestrator/agents` | List available agents |
| `POST` | `/api/orchestrator/approve` | Approve pending task |
| `POST` | `/api/orchestrator/reject` | Reject pending task |

### Code Review Bot

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/code-review/webhook` | GitHub webhook endpoint |
| `GET` | `/api/code-review/reviews` | List all reviews |
| `GET` | `/api/code-review/reviews/:id` | Get review detail |
| `GET` | `/api/code-review/metrics` | Get review metrics |
| `POST` | `/api/code-review/analyze` | Manual PR analysis |

### Tool Agent (Function Calling)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tool-agent/run` | Run agent query with tools (SSE) |
| `GET` | `/api/tool-agent/tools` | List available tools |
| `GET` | `/api/tool-agent/runs` | Get recent agent runs |
| `GET` | `/api/tool-agent/runs/:id` | Get specific run detail |

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

### Hybrid Search (Custom RAG)
- **BM25 Keyword Search**: Okapi BM25 algorithm for term-based retrieval
- **Hybrid Search**: Combines BM25 + Vector search with fusion methods (RRF, weighted, CombMNZ)
- **Re-ranking**: Cohere API + local fallback for improved relevance
- **Chunking Strategies**: Fixed, recursive, semantic, document-aware
- **Evaluation Metrics**: Recall@k, MRR, Precision@k, NDCG, context relevance, faithfulness
- **A/B Testing**: Framework for testing prompts, chunking strategies, and search configs

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

### Tool Agent (Function Calling)
- **Gemini Function Calling**: Structured tool definitions with JSON Schema
- **ReAct Reasoning Loop**: Multi-step reasoning with tool execution
- **4 Built-in Tools**: Web search (Jina), HTTP request, calculator, get current time
- **Agent Memory**: Conversation history preserved across reasoning steps
- **SSE Streaming**: Real-time streaming of reasoning steps and tool execution
- **Run History**: Track and query past agent runs

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
│   │   ├── eval.ts               # Eval type definitions
│   │   └── code-review.ts        # Code review types
│   ├── routes/
│   │   ├── conversations.ts      # Conversation CRUD
│   │   ├── messages.ts           # Chat + feedback (SSE)
│   │   ├── rag.ts                # RAG documents + query
│   │   ├── hybrid-search.ts      # Hybrid search + chunking + eval + A/B
│   │   ├── orchestrator.ts       # Multi-agent workflow
│   │   ├── eval.ts               # Eval metrics + runs
│   │   ├── safety.ts             # Safety gates + approvals
│   │   ├── code-review.ts        # AI code review bot
│   │   └── tool-agent.ts         # Tool agent (function calling)
│   └── services/
│       ├── embedder.ts           # Gemini embeddings + chunking
│       ├── qdrant.ts             # Qdrant vector DB
│       ├── bm25.ts               # BM25 keyword search
│       ├── hybrid-search.ts      # Hybrid search (BM25 + Vector)
│       ├── reranker.ts           # Re-ranking (Cohere + local)
│       ├── chunking.ts           # Chunking strategies
│       ├── eval-metrics.ts       # Evaluation metrics
│       ├── ab-testing.ts         # A/B testing framework
│       ├── github.ts             # GitHub API integration
│       ├── code-review-agent.ts  # Code review AI agent
│       ├── tool-agent/
│       │   ├── tools.ts          # Tool definitions + registry
│       │   ├── tool-agent.ts     # Agent with function calling + ReAct loop
│       │   └── index.ts          # Service exports
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
