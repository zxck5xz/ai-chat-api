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
      ├── D1 Database (conversations, messages)
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

#### POST `/api/messages/chat`

```json
// Request
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "conversationId": "uuid-optional"
}

// Response (SSE Stream)
data: {"type": "token", "content": "Hello"}
data: {"type": "token", "content": ", how"}
data: {"type": "done"}
```

### RAG (Retrieval-Augmented Generation)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/rag/documents` | List uploaded documents |
| `POST` | `/api/rag/documents` | Upload & embed document |
| `DELETE` | `/api/rag/documents/:id` | Delete document |
| `POST` | `/api/rag/query` | RAG query (SSE streaming) |

#### POST `/api/rag/query`

```json
// Request
{
  "query": "What is the main topic?",
  "mode": "rag" | "chat"
}

// Response (SSE Stream)
data: {"type": "token", "content": "Based on the documents..."}
data: {"type": "sources", "sources": [{"title": "...", "score": 0.95}]}
data: {"type": "done"}
```

### Multi-Agent Orchestrator

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/orchestrator/run` | Run multi-agent workflow (SSE) |
| `GET` | `/api/orchestrator/agents` | List available agents |
| `POST` | `/api/orchestrator/approve` | Approve pending task |
| `POST` | `/api/orchestrator/reject` | Reject pending task |

#### POST `/api/orchestrator/run`

```json
// Request
{
  "input": "Create a login form",
  "requireApproval": true
}

// Response (SSE Stream)
data: {"type": "task_start", "agent": "planner"}
data: {"type": "task_complete", "agent": "planner", "content": "..."}
data: {"type": "task_start", "taskId": "task-1", "agent": "designer"}
data: {"type": "approval_needed", "approvalId": "uuid", "taskId": "task-1"}
data: {"type": "workflow_complete"}
data: {"type": "workflow_result", "workflow": {...}}
```

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
# Paste your Gemini API key when prompted

npx wrangler secret put QDRANT_URL
# Paste your Qdrant URL when prompted

npx wrangler secret put QDRANT_API_KEY
# Paste your Qdrant API key when prompted
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
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  sources TEXT,  -- JSON string
  feedback_rating TEXT CHECK (feedback_rating IN ('positive', 'negative', NULL)),
  feedback_comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
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

## Models

| Model | Purpose | Notes |
|-------|---------|-------|
| `gemini-3.6-flash` | Chat + Agents | Primary model |
| `gemini-2.0-flash-lite` | Fallback | Lighter, more available |
| `gemini-embedding-004` | Embeddings | 3072 dimensions |

## Free Tier Limits (Cloudflare Workers)

| Resource | Limit |
|----------|-------|
| Requests | 100,000/day |
| CPU time | 10ms/request |
| D1 reads | 5M rows/day |
| D1 writes | 100K rows/day |
| D1 storage | 5 GB |

## Project Structure

```
ai-chat-api/
├── src/
│   ├── index.ts                  # Hono app + CORS + routes
│   ├── types.ts                  # TypeScript types
│   ├── types/
│   │   └── agents.ts             # Agent type definitions
│   ├── routes/
│   │   ├── conversations.ts      # Conversation CRUD
│   │   ├── messages.ts           # Chat + feedback (SSE)
│   │   ├── rag.ts                # RAG documents + query
│   │   └── orchestrator.ts       # Multi-agent workflow
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
