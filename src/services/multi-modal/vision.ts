import type {
  ImageAnalysisRequest,
  ImageAnalysisResult,
  AnalysisType,
} from '../../types/multi-modal';

const ANALYSIS_PROMPTS: Record<AnalysisType, string> = {
  describe: 'Describe this image in detail. Focus on the main subjects, setting, colors, and any notable features.',
  ocr: 'Extract all visible text from this image. Preserve the formatting and layout as much as possible. Return the text exactly as it appears.',
  compare: 'Analyze this image thoroughly for comparison purposes.',
  chart: 'Analyze this chart/graph. Extract all data points, labels, axes, trends, and insights. Return the data in a structured format.',
  code_screenshot: 'Extract the code from this screenshot. Return the exact code with proper formatting. Identify the programming language.',
  receipt: 'Extract all information from this receipt: store name, date, items with quantities and prices, subtotal, tax, total, payment method, and any other details.',
  document: 'Analyze this document page. Extract the text content, identify any tables, and describe the layout structure.',
  custom: 'Analyze this image based on the user\'s specific request.',
};

export class VisionAnalyzer {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async analyze(request: ImageAnalysisRequest): Promise<ImageAnalysisResult> {
    const startTime = Date.now();
    const prompt = request.prompt || ANALYSIS_PROMPTS[request.analysisType];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: request.mimeType,
                    data: request.imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.3,
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

    const description = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensUsed = data.usageMetadata?.totalTokenCount || 0;

    return {
      id: crypto.randomUUID(),
      analysisType: request.analysisType,
      description,
      extractedText: request.analysisType === 'ocr' ? description : undefined,
      confidence: 0.9,
      latencyMs: Date.now() - startTime,
      model: this.model,
      tokensUsed,
      costUsd: this.estimateCost(tokensUsed),
      created_at: new Date().toISOString(),
    };
  }

  async analyzeWithStream(
    request: ImageAnalysisRequest,
    onChunk: (chunk: string) => void
  ): Promise<ImageAnalysisResult> {
    const startTime = Date.now();
    const prompt = request.prompt || ANALYSIS_PROMPTS[request.analysisType];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: request.mimeType,
                    data: request.imageBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.3,
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
    let fullText = '';

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
              fullText += content;
              onChunk(content);
            }
          } catch {
            // Skip malformed SSE
          }
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      analysisType: request.analysisType,
      description: fullText,
      extractedText: request.analysisType === 'ocr' ? fullText : undefined,
      confidence: 0.9,
      latencyMs: Date.now() - startTime,
      model: this.model,
      tokensUsed: 0,
      costUsd: 0,
      created_at: new Date().toISOString(),
    };
  }

  async compare(request: {
    imageBase64A: string;
    imageBase64B: string;
    mimeType: string;
    prompt?: string;
  }): Promise<{
    similarities: string[];
    differences: string[];
    summary: string;
    sideBySideDescription: string;
  }> {
    const prompt = request.prompt || 
      'Compare these two images in detail. List the key similarities and differences. Provide a summary of what you observe.';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: request.mimeType,
                    data: request.imageBase64A,
                  },
                },
                {
                  inlineData: {
                    mimeType: request.mimeType,
                    data: request.imageBase64B,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.3,
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

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse the response to extract similarities and differences
    const similarities: string[] = [];
    const differences: string[] = [];

    const lines = text.split('\n');
    let currentSection = 'summary';

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes('similarit') || lower.includes('common') || lower.includes('alike')) {
        currentSection = 'similarities';
      } else if (lower.includes('difference') || lower.includes('differ') || lower.includes('contrast')) {
        currentSection = 'differences';
      } else if (line.trim().startsWith('-') || line.trim().startsWith('•') || line.trim().startsWith('*')) {
        const item = line.replace(/^[\s\-*•]+/, '').trim();
        if (item) {
          if (currentSection === 'similarities') similarities.push(item);
          else if (currentSection === 'differences') differences.push(item);
          else differences.push(item);
        }
      }
    }

    return {
      similarities: similarities.length ? similarities : ['Similar response format'],
      differences: differences.length ? differences : ['No major differences found'],
      summary: text,
      sideBySideDescription: text,
    };
  }

  private estimateCost(tokens: number): number {
    // Gemini Flash pricing (approximate)
    const inputTokens = tokens * 0.7;
    const outputTokens = tokens * 0.3;
    return (inputTokens * 0.000000075) + (outputTokens * 0.0000003);
  }
}
