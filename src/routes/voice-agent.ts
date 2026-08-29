import { Hono } from 'hono';
import type { Env } from '../types';
import { VoiceAgent } from '../services/voice-agent';

const voiceAgent = new Hono<{ Bindings: Env }>();

function createVoiceAgent(c: { env: Env }) {
  return new VoiceAgent(
    {
      geminiApiKey: c.env.GEMINI_API_KEY,
      openaiApiKey: c.env.OPENAI_API_KEY,
      elevenLabsApiKey: c.env.ELEVENLABS_API_KEY,
      db: c.env.DB,
    },
    {
      language: c.env.VOICE_LANGUAGE || 'en',
      voiceId: c.env.VOICE_ID,
    }
  );
}

// POST /transcribe - Audio to text via Whisper
voiceAgent.post('/transcribe', async (c) => {
  try {
    const body = await c.req.json<{ audioBase64: string; language?: string }>();
    const agent = createVoiceAgent(c);

    const result = await (agent as any).stt.transcribe(body.audioBase64, {
      language: body.language,
    });

    return c.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed';
    return c.json({ success: false, error: message }, 500);
  }
});

// POST /synthesize - Text to audio via TTS
voiceAgent.post('/synthesize', async (c) => {
  try {
    const body = await c.req.json<{ text: string; voiceId?: string; language?: string }>();
    const agent = createVoiceAgent(c);

    const result = await (agent as any).tts.synthesize(body.text, {
      voiceId: body.voiceId,
      language: body.language,
    });

    return c.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Synthesis failed';
    return c.json({ success: false, error: message }, 500);
  }
});

// POST /run - Full pipeline with SSE streaming
voiceAgent.post('/run', async (c) => {
  const body = await c.req.json<{
    audioBase64: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  }>();

  const agent = createVoiceAgent(c);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const history = (body.history || []).map((h) => ({
          id: crypto.randomUUID(),
          ...h,
        }));
        const session = await agent.run(
          body.audioBase64,
          history,
          sendEvent
        );

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', session })}\n\n`)
        );
      } catch (error) {
        sendEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// POST /run-stream - Full pipeline with streaming TTS
voiceAgent.post('/run-stream', async (c) => {
  const body = await c.req.json<{
    audioBase64: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  }>();

  const agent = createVoiceAgent(c);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const history = (body.history || []).map((h) => ({
          id: crypto.randomUUID(),
          ...h,
        }));
        const session = await agent.runStream(
          body.audioBase64,
          history,
          sendEvent
        );

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', session })}\n\n`)
        );
      } catch (error) {
        sendEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// GET /sessions - List voice sessions
voiceAgent.get('/sessions', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const agent = createVoiceAgent(c);
  const sessions = await agent.getSessions(limit);
  return c.json({ sessions });
});

// GET /sessions/:id - Get voice session detail
voiceAgent.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const agent = createVoiceAgent(c);
  const session = await agent.getSession(id);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ session });
});

// GET /metrics - Voice metrics
voiceAgent.get('/metrics', async (c) => {
  const agent = createVoiceAgent(c);
  const metrics = await agent.getMetrics();
  return c.json({ metrics });
});

export default voiceAgent;
