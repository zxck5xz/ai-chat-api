import { Hono } from 'hono';
import type { Env } from '../types';
import { OCRDetector, ImageGenerator } from '../services/image-text-replacement';

const imageText = new Hono<{ Bindings: Env }>();

function createServices(c: { env: Env }) {
  return {
    ocr: new OCRDetector(c.env.GEMINI_API_KEY),
    imageGenerator: new ImageGenerator(c.env.GEMINI_API_KEY),
  };
}

// POST /detect - Detect text regions in image (OCR with bounding boxes)
imageText.post('/detect', async (c) => {
  const body = await c.req.json<{
    imageBase64: string;
    mimeType: string;
  }>();

  const { ocr } = createServices(c);
  const result = await ocr.detectTextRegions(body.imageBase64, body.mimeType);

  return c.json({ success: true, result });
});

// POST /replace - Replace text in image and generate new image
imageText.post('/replace', async (c) => {
  const body = await c.req.json<{
    imageBase64: string;
    mimeType: string;
    replacements: Array<{
      regionId: string;
      originalText: string;
      newText: string;
    }>;
    style?: {
      fontSize?: string;
      fontFamily?: string;
      color?: string;
    };
  }>();

  const { imageGenerator } = createServices(c);

  const prompt = imageGenerator.buildReplacementPrompt(
    body.replacements,
    body.style
  );

  const editedImageBase64 = await imageGenerator.generateImage({
    imageBase64: body.imageBase64,
    mimeType: body.mimeType,
    prompt,
  });

  const result = {
    id: crypto.randomUUID(),
    originalImageUrl: `data:${body.mimeType};base64,${body.imageBase64}`,
    editedImageUrl: `data:image/png;base64,${editedImageBase64}`,
    replacements: body.replacements.map((r) => ({
      ...r,
      status: 'success' as const,
    })),
    latencyMs: 0,
    model: 'gemini-2.0-flash-exp',
    created_at: new Date().toISOString(),
  };

  return c.json({ success: true, result });
});

// POST /detect-and-preview - Detect regions and preview replacement prompt
imageText.post('/detect-and-preview', async (c) => {
  const body = await c.req.json<{
    imageBase64: string;
    mimeType: string;
  }>();

  const { ocr } = createServices(c);
  const ocrResult = await ocr.detectTextRegions(body.imageBase64, body.mimeType);

  return c.json({
    success: true,
    result: {
      ...ocrResult,
      imageWidth: body.imageBase64.length, // placeholder
      imageHeight: 0,
    },
  });
});

// GET /metrics - Usage metrics
imageText.get('/metrics', async (c) => {
  return c.json({
    metrics: {
      totalReplacements: 0,
      successRate: 1,
      avgLatencyMs: 0,
      totalRegionsDetected: 0,
    },
  });
});

export default imageText;
