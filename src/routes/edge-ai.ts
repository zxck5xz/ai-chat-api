// Project 18: Edge AI Inference — API Routes
import { Hono } from 'hono';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  category: string;
  modelId: string;
  sizeMB: number;
  minGPUMemoryMB: number;
  minRAMMB: number;
  description: string;
  quantization: string;
  maxTokens: number;
}

const AVAILABLE_MODELS: ModelRecord[] = [
  {
    id: 'llama-3.2-3b',
    name: 'Llama 3.2 3B',
    provider: 'webllm',
    category: 'text-generation',
    modelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    sizeMB: 2000,
    minGPUMemoryMB: 2048,
    minRAMMB: 4096,
    description: 'Meta Llama 3.2 3B — fast instruction-following model for edge devices',
    quantization: 'q4f16_1',
    maxTokens: 4096,
  },
  {
    id: 'phi-3.5-mini',
    name: 'Phi-3.5 Mini',
    provider: 'webllm',
    category: 'text-generation',
    modelId: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    sizeMB: 2400,
    minGPUMemoryMB: 2560,
    minRAMMB: 4096,
    description: 'Microsoft Phi-3.5 Mini — compact yet capable reasoning model',
    quantization: 'q4f16_1',
    maxTokens: 4096,
  },
  {
    id: 'gemma-2-2b',
    name: 'Gemma 2 2B',
    provider: 'webllm',
    category: 'text-generation',
    modelId: 'gemma-2-2b-it-q4f16_1-MLC',
    sizeMB: 1600,
    minGPUMemoryMB: 1536,
    minRAMMB: 3072,
    description: 'Google Gemma 2 2B — lightweight efficient model',
    quantization: 'q4f16_1',
    maxTokens: 4096,
  },
  {
    id: 'qwen2.5-1.5b',
    name: 'Qwen2.5 1.5B',
    provider: 'webllm',
    category: 'text-generation',
    modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    sizeMB: 1100,
    minGPUMemoryMB: 1024,
    minRAMMB: 2048,
    description: 'Alibaba Qwen2.5 1.5B — smallest Qwen model, great for low-end devices',
    quantization: 'q4f16_1',
    maxTokens: 2048,
  },
  {
    id: 'distilbert-sst2',
    name: 'DistilBERT SST-2',
    provider: 'onnx',
    category: 'classification',
    modelId: 'distilbert-base-uncased-finetuned-sst-2-english',
    sizeMB: 67,
    minGPUMemoryMB: 0,
    minRAMMB: 512,
    description: 'DistilBERT sentiment classifier (positive/negative) — runs on CPU via ONNX',
    quantization: 'fp32',
    maxTokens: 512,
  },
  {
    id: 'mini-lm embeddings',
    name: 'MiniLM-L6 Embeddings',
    provider: 'onnx',
    category: 'embedding',
    modelId: 'all-MiniLM-L6-v2',
    sizeMB: 23,
    minGPUMemoryMB: 0,
    minRAMMB: 256,
    description: 'Sentence transformer embeddings (384-dim) — fast CPU inference via ONNX',
    quantization: 'fp32',
    maxTokens: 256,
  },
];

interface InferenceRecord {
  id: string;
  modelId: string;
  input: string;
  output: string;
  mode: string;
  tokensGenerated: number;
  tokensPerSecond: number;
  latencyMs: number;
  memoryUsedMB: number;
  provider: string;
  created_at: string;
}

// GET /models - List available models
router.get('/models', (c) => {
  return c.json({ models: AVAILABLE_MODELS });
});

// GET /models/:id - Get specific model info
router.get('/models/:id', (c) => {
  const model = AVAILABLE_MODELS.find((m) => m.id === c.req.param('id'));
  if (!model) return c.json({ error: 'Model not found' }, 404);
  return c.json({ model });
});

// POST /detect-device - Detect device capabilities
router.post('/detect-device', async (c) => {
  const body = await c.req.json<{
    webgpuSupported?: boolean;
    gpuMemoryMB?: number;
    totalRAMMB?: number;
    cpuCores?: number;
  }>();

  const webgpuSupported = body.webgpuSupported ?? false;
  const gpuMemoryMB = body.gpuMemoryMB ?? 0;
  const totalRAMMB = body.totalRAMMB ?? 4096;
  const cpuCores = body.cpuCores ?? 4;

  let capability: string = 'unsupported';
  if (webgpuSupported && gpuMemoryMB >= 4096) {
    capability = 'high-end';
  } else if (webgpuSupported && gpuMemoryMB >= 1536) {
    capability = 'mid-range';
  } else if (totalRAMMB >= 2048) {
    capability = 'low-end';
  }

  const recommendedModels = AVAILABLE_MODELS.filter((m) => {
    if (m.provider === 'onnx') return true;
    return webgpuSupported && m.minGPUMemoryMB <= gpuMemoryMB && m.minRAMMB <= totalRAMMB;
  }).map((m) => m.id);

  return c.json({
    device: {
      gpuAvailable: webgpuSupported,
      gpuMemoryMB,
      webgpuSupported,
      totalRAMMB,
      cpuCores,
      capability,
      recommendedModels,
    },
  });
});

// POST /inference - Run inference (cloud fallback endpoint)
router.post('/inference', async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'Gemini API key not configured' }, 500);

  const body = await c.req.json<{
    prompt: string;
    modelId?: string;
    maxTokens?: number;
    temperature?: number;
  }>();

  if (!body.prompt || body.prompt.trim().length === 0) {
    return c.json({ error: 'Prompt is required' }, 400);
  }

  const startTime = Date.now();
  const maxTokens = body.maxTokens ?? 256;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${c.env.GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: body.prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: body.temperature ?? 0.7,
        },
      }),
    });

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const latencyMs = Date.now() - startTime;
    const tokensGenerated = text.split(/\s+/).length;

    return c.json({
      result: {
        id: crypto.randomUUID(),
        modelId: 'gemini-2.0-flash',
        input: body.prompt,
        output: text,
        mode: 'cloud',
        tokensGenerated,
        tokensPerSecond: tokensGenerated / (latencyMs / 1000),
        latencyMs,
        memoryUsedMB: 0,
        provider: 'cloud',
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: 'Cloud inference failed', message: msg }, 500);
  }
});

// POST /log-inference - Log an inference result
router.post('/log-inference', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const body = await c.req.json<InferenceRecord>();
  const id = body.id || crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO edge_ai_inferences (id, model_id, input_tokens, output_tokens, mode, tokens_per_second, latency_ms, memory_mb, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.modelId,
      body.input.length,
      body.tokensGenerated,
      body.mode,
      body.tokensPerSecond,
      body.latencyMs,
      body.memoryUsedMB,
      body.provider,
      body.created_at || new Date().toISOString()
    )
    .run();

  return c.json({ success: true, id });
});

// GET /metrics - Aggregated performance metrics
router.get('/metrics', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const all = await c.env.DB.prepare(
    `SELECT * FROM edge_ai_inferences ORDER BY created_at DESC LIMIT 500`
  ).all<{ id: string; model_id: string; mode: string; tokens_per_second: number; latency_ms: number; memory_mb: number; created_at: string }>();

  const results = all.results || [];
  const total = results.length;
  if (total === 0) {
    return c.json({
      metrics: {
        totalInferences: 0,
        avgTokensPerSecond: 0,
        avgLatencyMs: 0,
        avgMemoryMB: 0,
        localInferences: 0,
        cloudInferences: 0,
        hybridInferences: 0,
        modelsLoaded: 0,
        infByModel: {},
      },
    });
  }

  const avgTPS = results.reduce((s, r) => s + r.tokens_per_second, 0) / total;
  const avgLat = results.reduce((s, r) => s + r.latency_ms, 0) / total;
  const avgMem = results.reduce((s, r) => s + r.memory_mb, 0) / total;
  const localCount = results.filter((r) => r.mode === 'local').length;
  const cloudCount = results.filter((r) => r.mode === 'cloud').length;
  const hybridCount = results.filter((r) => r.mode === 'hybrid').length;

  const byModel: Record<string, number> = {};
  for (const r of results) {
    byModel[r.model_id] = (byModel[r.model_id] || 0) + 1;
  }

  return c.json({
    metrics: {
      totalInferences: total,
      avgTokensPerSecond: Math.round(avgTPS * 100) / 100,
      avgLatencyMs: Math.round(avgLat),
      avgMemoryMB: Math.round(avgMem),
      localInferences: localCount,
      cloudInferences: cloudCount,
      hybridInferences: hybridCount,
      modelsLoaded: Object.keys(byModel).length,
      infByModel: byModel,
    },
  });
});

// GET /history - Recent inference history
router.get('/history', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);

  const limit = parseInt(c.req.query('limit') || '50');
  const results = await c.env.DB.prepare(
    `SELECT * FROM edge_ai_inferences ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();

  return c.json({ history: results.results || [] });
});

// DELETE /history - Clear inference history
router.delete('/history', async (c) => {
  if (!c.env.DB) return c.json({ error: 'Database not configured' }, 500);
  await c.env.DB.prepare(`DELETE FROM edge_ai_inferences`).run();
  return c.json({ success: true });
});

// GET /health
router.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'edge-ai',
    models: AVAILABLE_MODELS.length,
    webllm: true,
    onnx: true,
  });
});

export default router;
