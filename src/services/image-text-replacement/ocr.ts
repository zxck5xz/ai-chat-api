import type { TextRegion, OCRResult } from '../../types/image-text-replacement';

const OCR_PROMPT = `Analyze this image and detect ALL text regions. For each text region, provide:
1. The exact text content
2. The bounding box coordinates as percentage of image dimensions (x%, y%, width%, height%)
3. Confidence score (0-1)
4. Approximate font size (small/medium/large)
5. Text color if discernible

Return a JSON array of text regions. Example format:
[
  {
    "text": "Hello World",
    "x": 10.5,
    "y": 20.3,
    "width": 30.2,
    "height": 5.1,
    "confidence": 0.95,
    "fontSize": "large",
    "color": "#000000"
  }
]

Rules:
- Detect ALL visible text, including small text
- Use percentage coordinates (0-100) relative to image dimensions
- Include text on signs, labels, buttons, headers, body text, etc.
- If no text is found, return an empty array []
- Return ONLY the JSON array, no explanations`;

export class OCRDetector {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async detectTextRegions(
    imageBase64: string,
    mimeType: string
  ): Promise<OCRResult> {
    const startTime = Date.now();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: OCR_PROMPT },
                {
                  inlineData: {
                    mimeType,
                    data: imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.2,
            responseMimeType: 'application/json',
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

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    let rawRegions: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      confidence: number;
      fontSize?: string;
      color?: string;
    }>;

    try {
      rawRegions = JSON.parse(text);
    } catch {
      rawRegions = [];
    }

    const regions: TextRegion[] = rawRegions.map((r, i) => ({
      id: `region-${i}`,
      text: r.text,
      bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
      confidence: r.confidence || 0.8,
      fontSize: r.fontSize,
      color: r.color,
    }));

    return {
      id: crypto.randomUUID(),
      regions,
      fullText: regions.map((r) => r.text).join('\n'),
      imageWidth: 0,
      imageHeight: 0,
      latencyMs: Date.now() - startTime,
      model: this.model,
      created_at: new Date().toISOString(),
    };
  }
}
