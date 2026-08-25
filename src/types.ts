export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources: string | null;
  feedback_rating: 'positive' | 'negative' | null;
  feedback_comment: string | null;
  created_at: string;
}

export interface Source {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
}