import { Hono } from 'hono';
import type { Env } from '../types';
import { VisionAnalyzer, DocumentUnderstanding } from '../services/multi-modal';

const multiModal = new Hono<{ Bindings: Env }>();

function createServices(c: { env: Env }) {
  return {
    vision: new VisionAnalyzer(c.env.GEMINI_API_KEY),
    document: new DocumentUnderstanding(c.env.GEMINI_API_KEY),
  };
}

// POST /analyze - Analyze an image
multiModal.post('/analyze', async (c) => {
  const body = await c.req.json<{
    imageBase64: string;
    mimeType: string;
    prompt?: string;
    analysisType?: string;
    language?: string;
  }>();

  const { vision } = createServices(c);

  const result = await vision.analyze({
    imageBase64: body.imageBase64,
    mimeType: body.mimeType,
    prompt: body.prompt,
    analysisType: (body.analysisType as any) || 'describe',
    language: body.language,
  });

  return c.json({ success: true, result });
});

// POST /analyze-stream - Analyze an image with streaming
multiModal.post('/analyze-stream', async (c) => {
  const body = await c.req.json<{
    imageBase64: string;
    mimeType: string;
    prompt?: string;
    analysisType?: string;
  }>();

  const { vision } = createServices(c);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await vision.analyzeWithStream(
          {
            imageBase64: body.imageBase64,
            mimeType: body.mimeType,
            prompt: body.prompt,
            analysisType: (body.analysisType as any) || 'describe',
          },
          (chunk) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`)
            );
          }
        );

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', result })}\n\n`)
        );
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' })}\n\n`
          )
        );
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

// POST /compare - Compare two images
multiModal.post('/compare', async (c) => {
  const body = await c.req.json<{
    imageBase64A: string;
    imageBase64B: string;
    mimeType: string;
    prompt?: string;
  }>();

  const { vision } = createServices(c);

  const comparison = await vision.compare({
    imageBase64A: body.imageBase64A,
    imageBase64B: body.imageBase64B,
    mimeType: body.mimeType,
    prompt: body.prompt,
  });

  const result = {
    id: crypto.randomUUID(),
    ...comparison,
    latencyMs: 0,
    model: 'gemini-2.0-flash',
    created_at: new Date().toISOString(),
  };

  return c.json({ success: true, result });
});

// POST /understand - Document understanding
multiModal.post('/understand', async (c) => {
  const body = await c.req.json<{
    documentBase64: string;
    mimeType: string;
    pages?: number[];
    extractTables?: boolean;
    extractImages?: boolean;
  }>();

  const { document: docUnderstanding } = createServices(c);

  const result = await docUnderstanding.understand({
    documentBase64: body.documentBase64,
    mimeType: body.mimeType,
    pages: body.pages,
    extractTables: body.extractTables,
    extractImages: body.extractImages,
  });

  return c.json({ success: true, result });
});

// POST /extract-text - Extract text from document
multiModal.post('/extract-text', async (c) => {
  const body = await c.req.json<{
    documentBase64: string;
    mimeType: string;
  }>();

  const { document: docUnderstanding } = createServices(c);

  const text = await docUnderstanding.extractText(body.documentBase64, body.mimeType);

  return c.json({ success: true, text });
});

// POST /chat - Multi-modal chat with images
multiModal.post('/chat', async (c) => {
  const body = await c.req.json<{
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      images?: Array<{ base64: string; mimeType: string }>;
    }>;
  }>();

  const contents = body.messages.map((msg) => {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: msg.content },
    ];

    if (msg.images) {
      for (const img of msg.images) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        });
      }
    }

    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts,
    };
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${c.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.7,
        },
        systemInstruction: {
          parts: [
            {
              text: 'You are a helpful multimodal assistant. Analyze images carefully and provide detailed, accurate responses. When images are provided, reference them explicitly in your response.',
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
    usageMetadata?: { totalTokenCount: number };
  };

  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return c.json({
    success: true,
    reply,
    tokensUsed: data.usageMetadata?.totalTokenCount || 0,
  });
});

// GET /metrics - Multi-modal usage metrics
multiModal.get('/metrics', async (c) => {
  return c.json({
    metrics: {
      totalAnalyses: 0,
      analysesByType: {},
      avgLatencyMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      topModels: [],
    },
  });
});

export default multiModal;
