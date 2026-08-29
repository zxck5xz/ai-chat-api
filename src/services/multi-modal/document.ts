import type {
  DocumentUnderstandingRequest,
  DocumentUnderstandingResult,
  DocumentPage,
} from '../../types/multi-modal';

export class DocumentUnderstanding {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async understand(request: DocumentUnderstandingRequest): Promise<DocumentUnderstandingResult> {
    const startTime = Date.now();

    const prompt = `Analyze this document page. Extract ALL text content preserving structure.
Identify any tables (return as structured data with headers and rows).
Identify any embedded images (describe them and note positions).
Describe the page layout (columns, headers, footers, margins).
Return the analysis as JSON with this structure:
{
  "text": "full extracted text",
  "tables": [{"headers": [...], "rows": [[...], ...], "confidence": 0.9}],
  "images": [{"description": "...", "position": {"x": 0, "y": 0, "width": 100, "height": 100}}],
  "layout": {"width": 800, "height": 1100, "columns": 1, "hasHeader": true, "hasFooter": false}
}`;

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: prompt },
    ];

    // Add the document page
    if (request.mimeType === 'application/pdf') {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: request.documentBase64,
        },
      });
    } else {
      parts.push({
        inlineData: {
          mimeType: request.mimeType,
          data: request.documentBase64,
        },
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.1,
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
      usageMetadata?: { totalTokenCount: number };
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    let pageData: {
      text: string;
      tables?: DocumentPage['tables'];
      images?: DocumentPage['images'];
      layout?: DocumentPage['layout'];
    };

    try {
      pageData = JSON.parse(text);
    } catch {
      pageData = { text };
    }

    const page: DocumentPage = {
      pageNumber: 1,
      text: pageData.text,
      tables: pageData.tables,
      images: pageData.images,
      layout: pageData.layout,
    };

    const wordCount = pageData.text.split(/\s+/).filter(Boolean).length;

    return {
      id: crypto.randomUUID(),
      totalPages: 1,
      pages: [page],
      fullText: pageData.text,
      summary: pageData.text.slice(0, 500) + (pageData.text.length > 500 ? '...' : ''),
      metadata: {
        pageCount: 1,
        wordCount,
      },
      latencyMs: Date.now() - startTime,
      model: this.model,
      created_at: new Date().toISOString(),
    };
  }

  async extractText(documentBase64: string, mimeType: string): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: 'Extract ALL text from this document exactly as it appears. Preserve formatting, line breaks, and structure. Return ONLY the extracted text without any additional commentary.' },
                {
                  inlineData: {
                    mimeType,
                    data: documentBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.1,
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
}
