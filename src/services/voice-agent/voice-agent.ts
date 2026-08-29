import type {
  VoiceSession,
  VoiceEvent,
  TranscriptEntry,
  VoiceAgentConfig,
  VoiceMetrics,
} from '../../types/voice-agent';
import type { STTResult } from '../../types/voice-agent';
import { WhisperSTT, MockSTT, type STTService } from './stt';
import { ElevenLabsTTS, OpenAITTS, MockTTS, type TTSProvider } from './tts';

interface VoiceAgentDeps {
  apiKey?: string;
  geminiApiKey: string;
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
  db?: D1Database;
}

// In-memory store for active agent sessions (keyed by sessionId)
const activeSessions = new Map<string, VoiceAgent>();

export function getActiveAgent(sessionId: string): VoiceAgent | undefined {
  return activeSessions.get(sessionId);
}

export function removeActiveAgent(sessionId: string): void {
  activeSessions.delete(sessionId);
}

export class VoiceAgent {
  private stt: STTService;
  private tts: TTSProvider;
  private geminiApiKey: string;
  private db?: D1Database;
  private config: VoiceAgentConfig;
  private isInterrupted = false;
  private abortController: AbortController | null = null;

  constructor(deps: VoiceAgentDeps, config?: Partial<VoiceAgentConfig>) {
    this.geminiApiKey = deps.geminiApiKey;
    this.db = deps.db;
    this.config = {
      sttProvider: 'whisper',
      ttsProvider: deps.elevenLabsApiKey ? 'elevenlabs' : 'openai',
      llmModel: 'gemini-2.0-flash',
      interruptionEnabled: true,
      ...config,
    };

    // Initialize STT
    if (deps.openaiApiKey && this.config.sttProvider === 'whisper') {
      this.stt = new WhisperSTT(deps.openaiApiKey);
    } else {
      this.stt = new MockSTT();
    }

    // Initialize TTS
    if (deps.elevenLabsApiKey && this.config.ttsProvider === 'elevenlabs') {
      this.tts = new ElevenLabsTTS(deps.elevenLabsApiKey, config?.voiceId);
    } else if (deps.openaiApiKey) {
      this.tts = new OpenAITTS(deps.openaiApiKey);
    } else {
      this.tts = new MockTTS();
    }
  }

  interrupt() {
    this.isInterrupted = true;
    this.abortController?.abort();
  }

  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  async run(
    audioBase64: string,
    conversationHistory: TranscriptEntry[] = [],
    onEvent: (event: VoiceEvent) => void
  ): Promise<VoiceSession> {
    const sessionId = crypto.randomUUID();
    const startTime = Date.now();
    this.isInterrupted = false;
    this.abortController = new AbortController();
    activeSessions.set(sessionId, this);

    onEvent({ type: 'session_started', sessionId });

    const transcript: TranscriptEntry[] = [...conversationHistory];

    try {
      // Step 1: STT - Transcribe audio
      onEvent({ type: 'transcribing' });
      const sttResult = await this.stt.transcribe(audioBase64, {
        language: this.config.language,
      });

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'transcribe' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({ type: 'transcribed', text: sttResult.text, language: sttResult.language });

      // Add user turn to transcript
      transcript.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: sttResult.text,
        latencyMs: sttResult.durationMs,
        timestamp: new Date().toISOString(),
      });

      // Step 2: LLM - Generate response
      onEvent({ type: 'thinking' });
      const llmResponse = await this.generateResponse(sttResult, transcript);

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'llm' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({ type: 'llm_done', content: llmResponse });

      // Add assistant turn to transcript
      transcript.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: llmResponse,
        timestamp: new Date().toISOString(),
      });

      // Step 3: TTS - Synthesize speech
      onEvent({ type: 'synthesizing' });
      const ttsResult = await this.tts.synthesize(llmResponse, {
        voiceId: this.config.voiceId,
        language: this.config.language,
      });

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'synthesize' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({
        type: 'audio_chunk',
        audioBase64: ttsResult.audioBase64,
        format: ttsResult.format,
      });
      onEvent({ type: 'audio_done', totalChunks: 1 });

      // Complete
      const session = this.buildSession(sessionId, transcript, 'completed', startTime);
      onEvent({
        type: 'completed',
        transcript,
        totalLatencyMs: Date.now() - startTime,
      });

      // Save to D1
      if (this.db) {
        await this.saveSession(session);
      }

      activeSessions.delete(sessionId);
      return session;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      onEvent({ type: 'error', message: errorMessage });
      activeSessions.delete(sessionId);
      return this.buildSession(sessionId, transcript, 'failed', startTime);
    }
  }

  async runStream(
    audioBase64: string,
    conversationHistory: TranscriptEntry[] = [],
    onEvent: (event: VoiceEvent) => void
  ): Promise<VoiceSession> {
    const sessionId = crypto.randomUUID();
    const startTime = Date.now();
    this.isInterrupted = false;
    this.abortController = new AbortController();
    activeSessions.set(sessionId, this);

    onEvent({ type: 'session_started', sessionId });

    const transcript: TranscriptEntry[] = [...conversationHistory];

    try {
      // Step 1: STT
      onEvent({ type: 'transcribing' });
      const sttResult = await this.stt.transcribe(audioBase64, {
        language: this.config.language,
      });

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'transcribe' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({ type: 'transcribed', text: sttResult.text, language: sttResult.language });

      transcript.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: sttResult.text,
        latencyMs: sttResult.durationMs,
        timestamp: new Date().toISOString(),
      });

      // Step 2: LLM with streaming
      onEvent({ type: 'thinking' });
      let fullResponse = '';

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.config.llmModel}:streamGenerateContent?alt=sse&key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: this.abortController?.signal,
          body: JSON.stringify({
            contents: [
              ...conversationHistory.map((entry) => ({
                role: entry.role === 'user' ? 'user' : 'model',
                parts: [{ text: entry.content }],
              })),
              { role: 'user', parts: [{ text: sttResult.text }] },
            ],
            generationConfig: {
              maxOutputTokens: 1024,
              temperature: 0.7,
            },
            systemInstruction: {
              parts: [
                {
                  text: 'You are a helpful voice assistant. Keep responses concise and conversational, suitable for text-to-speech. Avoid special characters, markdown, or code blocks. Respond naturally as if speaking.',
                },
              ],
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (content) {
                fullResponse += content;
                onEvent({ type: 'llm_chunk', content });
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      }

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'llm' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({ type: 'llm_done', content: fullResponse });

      transcript.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date().toISOString(),
      });

      // Step 3: TTS streaming
      onEvent({ type: 'synthesizing' });
      let chunkCount = 0;

      for await (const chunk of this.tts.synthesizeStream(fullResponse, {
        voiceId: this.config.voiceId,
        language: this.config.language,
      })) {
        if (this.isInterrupted) break;
        if (!chunk.isLast) {
          onEvent({ type: 'audio_chunk', audioBase64: chunk.audioBase64, format: chunk.format });
          chunkCount++;
        }
      }

      if (this.isInterrupted) {
        onEvent({ type: 'interrupted', atStep: 'synthesize' });
        activeSessions.delete(sessionId);
        return this.buildSession(sessionId, transcript, 'interrupted', startTime);
      }

      onEvent({ type: 'audio_done', totalChunks: chunkCount });

      const session = this.buildSession(sessionId, transcript, 'completed', startTime);
      onEvent({
        type: 'completed',
        transcript,
        totalLatencyMs: Date.now() - startTime,
      });

      if (this.db) {
        await this.saveSession(session);
      }

      activeSessions.delete(sessionId);
      return session;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      onEvent({ type: 'error', message: errorMessage });
      activeSessions.delete(sessionId);
      return this.buildSession(sessionId, transcript, 'failed', startTime);
    }
  }

  private async generateResponse(
    sttResult: STTResult,
    transcript: TranscriptEntry[]
  ): Promise<string> {
    const history = transcript.map((entry) => ({
      role: entry.role === 'user' ? 'user' : 'model',
      parts: [{ text: entry.content }],
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.config.llmModel}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abortController?.signal,
        body: JSON.stringify({
          contents: history,
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
          },
          systemInstruction: {
            parts: [
              {
                text: 'You are a helpful voice assistant. Keep responses concise and conversational, suitable for text-to-speech. Avoid special characters, markdown, or code blocks.',
              },
            ],
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  private buildSession(
    id: string,
    transcript: TranscriptEntry[],
    status: VoiceSession['status'],
    startTime: number
  ): VoiceSession {
    return {
      id,
      status,
      transcript: JSON.stringify(transcript),
      user_language: this.config.language || 'en',
      total_turns: transcript.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      total_latency_ms: Date.now() - startTime,
      created_at: new Date(startTime).toISOString(),
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    };
  }

  private async saveSession(session: VoiceSession): Promise<void> {
    if (!this.db) return;

    await this.db
      .prepare(
        `INSERT INTO voice_sessions (id, status, transcript, user_language, total_turns, total_input_tokens, total_output_tokens, total_cost_usd, total_latency_ms, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.status,
        session.transcript,
        session.user_language,
        session.total_turns,
        session.total_input_tokens,
        session.total_output_tokens,
        session.total_cost_usd,
        session.total_latency_ms,
        session.created_at,
        session.completed_at
      )
      .run();
  }

  async getSessions(limit = 20): Promise<VoiceSession[]> {
    if (!this.db) return [];

    const result = await this.db
      .prepare(
        `SELECT id, status, transcript, user_language, total_turns, total_input_tokens, total_output_tokens, total_cost_usd, total_latency_ms, created_at, completed_at
         FROM voice_sessions ORDER BY created_at DESC LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results.map((row) => ({
      id: row.id as string,
      status: row.status as VoiceSession['status'],
      transcript: row.transcript as string,
      user_language: row.user_language as string,
      total_turns: row.total_turns as number,
      total_input_tokens: row.total_input_tokens as number,
      total_output_tokens: row.total_output_tokens as number,
      total_cost_usd: row.total_cost_usd as number,
      total_latency_ms: row.total_latency_ms as number,
      created_at: row.created_at as string,
      completed_at: row.completed_at as string | null,
    }));
  }

  async getSession(id: string): Promise<VoiceSession | null> {
    if (!this.db) return null;

    const result = await this.db
      .prepare(
        `SELECT id, status, transcript, user_language, total_turns, total_input_tokens, total_output_tokens, total_cost_usd, total_latency_ms, created_at, completed_at
         FROM voice_sessions WHERE id = ?`
      )
      .bind(id)
      .first();

    if (!result) return null;

    return {
      id: result.id as string,
      status: result.status as VoiceSession['status'],
      transcript: result.transcript as string,
      user_language: result.user_language as string,
      total_turns: result.total_turns as number,
      total_input_tokens: result.total_input_tokens as number,
      total_output_tokens: result.total_output_tokens as number,
      total_cost_usd: result.total_cost_usd as number,
      total_latency_ms: result.total_latency_ms as number,
      created_at: result.created_at as string,
      completed_at: result.completed_at as string | null,
    };
  }

  async getMetrics(): Promise<VoiceMetrics> {
    if (!this.db) {
      return {
        totalSessions: 0,
        totalTurns: 0,
        avgLatencyMs: 0,
        avgSTTLatencyMs: 0,
        avgTTSLatencyMs: 0,
        avgLLMLatencyMs: 0,
        totalCostUsd: 0,
        interruptionRate: 0,
      };
    }

    const result = await this.db
      .prepare(
        `SELECT
          COUNT(*) as total_sessions,
          SUM(total_turns) as total_turns,
          AVG(total_latency_ms) as avg_latency_ms,
          SUM(total_cost_usd) as total_cost_usd,
          SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) as interrupted_count
         FROM voice_sessions`
      )
      .first();

    return {
      totalSessions: (result?.total_sessions as number) || 0,
      totalTurns: (result?.total_turns as number) || 0,
      avgLatencyMs: (result?.avg_latency_ms as number) || 0,
      avgSTTLatencyMs: 0,
      avgTTSLatencyMs: 0,
      avgLLMLatencyMs: 0,
      totalCostUsd: (result?.total_cost_usd as number) || 0,
      interruptionRate:
        result?.total_sessions
          ? ((result?.interrupted_count as number) / (result?.total_sessions as number)) * 100
          : 0,
    };
  }
}
