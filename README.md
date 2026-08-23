# AI Chat API

Backend API cho AI Chat UI — built với **Hono** + **Cloudflare Workers** + **D1** + **Google Gemini**.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Cloudflare Workers | Edge serverless functions |
| Framework | Hono | Lightweight web framework |
| Database | Cloudflare D1 | Serverless SQLite |
| AI | Google Gemini API | LLM inference (free tier) |

## Architecture

```
Client (Next.js)
      ↓
Cloudflare Workers (Hono)
      ├── D1 Database (conversations, messages)
      └── Google Gemini API (AI responses)
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
| `POST` | `/api/messages/chat` | Send message & get AI response |
| `PUT` | `/api/messages/:id/feedback` | Update feedback (thumbs up/down) |

#### POST `/api/messages/chat`

```json
// Request
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "conversationId": "uuid-optional"
}

// Response
{
  "content": "AI response text...",
  "sources": [
    {
      "id": "src-1",
      "title": "Source title",
      "url": "https://example.com",
      "snippet": "Relevant excerpt",
      "score": 0.95
    }
  ]
}
```

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Google Gemini API key ([get one here](https://aistudio.google.com/apikey))

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

- **AI Chat**: Proxy to Google Gemini API with system prompt
- **Conversation Management**: CRUD operations on conversations
- **Message Persistence**: Save all messages to D1
- **Feedback System**: Thumbs up/down on assistant messages
- **Auto-retry**: Retry with fallback models on overload
- **Auto-create**: Create conversation on first message
- **CORS**: Configured for frontend integration

## Models

| Model | Priority | Notes |
|-------|----------|-------|
| `gemini-3.6-flash` | Primary | Latest, fastest |
| `gemini-2.0-flash-lite` | Fallback | Lighter, more available |

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
│   ├── index.ts              # Hono app + CORS + routes
│   ├── types.ts              # TypeScript types
│   └── routes/
│       ├── conversations.ts  # Conversation CRUD
│       └── messages.ts       # Chat + feedback
├── schema.sql                # D1 database schema
├── wrangler.toml             # Cloudflare Workers config
├── .dev.vars                 # Local environment variables
└── package.json
```

## License

MIT
