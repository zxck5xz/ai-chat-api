export type VoiceSessionStatus = 'listening' | 'processing' | 'speaking' | 'completed' | 'failed' | 'interrupted';

export type VoiceEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'transcribing'; }
  | { type: 'transcribed'; text: string; language: string }
  | { type: 'thinking'; }
  | { type: 'llm_chunk'; content: string }
  | { type: 'llm_done'; content: string }
  | { type: 'synthesizing'; }
  | { type: 'audio_chunk'; audioBase64: string; format: string }
  | { type: 'audio_done'; totalChunks: number }
  | { type: 'completed'; transcript: TranscriptEntry[]; totalLatencyMs: number }
  | { type: 'error'; message: string }
  | { type: 'interrupted'; atStep: string };

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  audioUrl?: string;
  latencyMs?: number;
  timestamp: string;
}

export interface VoiceSession {
  id: string;
  status: VoiceSessionStatus;
  transcript: string; // JSON string of TranscriptEntry[]
  user_language: string;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_latency_ms: number;
  created_at: string;
  completed_at: string | null;
}

export interface STTResult {
  text: string;
  language: string;
  durationMs: number;
  segments?: { start: number; end: number; text: string }[];
}

export interface TTSResult {
  audioBase64: string;
  format: string;
  durationMs: number;
  characterCount: number;
}

export interface VoiceAgentConfig {
  sttProvider: 'whisper';
  ttsProvider: 'elevenlabs' | 'openai';
  llmModel: string;
  voiceId?: string;
  language?: string;
  interruptionEnabled: boolean;
}

export interface VoiceMetrics {
  totalSessions: number;
  totalTurns: number;
  avgLatencyMs: number;
  avgSTTLatencyMs: number;
  avgTTSLatencyMs: number;
  avgLLMLatencyMs: number;
  totalCostUsd: number;
  interruptionRate: number;
}
