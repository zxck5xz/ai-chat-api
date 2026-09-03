const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const TEXT_EMBEDDING_MODEL = 'gemini-embedding-001';
const MULTIMODAL_EMBEDDING_MODEL = 'multimodalembedding';

export class MultiModalEmbedder {
  private geminiApiKey: string;

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async embedText(text: string): Promise<number[]> {
    const response = await fetch(
      `${GEMINI_API_URL}/models/${TEXT_EMBEDDING_MODEL}:embedContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${TEXT_EMBEDDING_MODEL}`,
          content: {
            parts: [{ text }],
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Text embedding failed: ${response.status} - ${error}`);
    }

    const result = await response.json() as { embedding?: { values?: number[] } };
    return result.embedding?.values || [];
  }

  async embedImage(imageBase64: string, mimeType: string): Promise<number[]> {
    const response = await fetch(
      `${GEMINI_API_URL}/models/${MULTIMODAL_EMBEDDING_MODEL}:embedContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${MULTIMODAL_EMBEDDING_MODEL}`,
          content: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: imageBase64,
                },
              },
            ],
          },
        }),
      }
    );

    if (!response.ok) {
      // Fallback: use Gemini vision to describe image, then embed the description
      return this.embedImageViaDescription(imageBase64, mimeType);
    }

    const result = await response.json() as { embedding?: { values?: number[] } };
    return result.embedding?.values || [];
  }

  private async embedImageViaDescription(imageBase64: string, mimeType: string): Promise<number[]> {
    const describeResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: 'Describe this image in detail for search indexing. Focus on: objects, people, scene, colors, text visible, and any notable features. Return only the description.' },
                { inlineData: { mimeType, data: imageBase64 } },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0.1,
          },
        }),
      }
    );

    if (!describeResponse.ok) {
      throw new Error(`Image description failed: ${describeResponse.status}`);
    }

    const describeData = await describeResponse.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    const description = describeData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return this.embedText(description);
  }

  async embedMultiModal(content: string, imageBase64?: string, mimeType?: string): Promise<number[]> {
    if (imageBase64 && mimeType) {
      // Embed both text and image, then average the vectors
      const [textEmbedding, imageEmbedding] = await Promise.all([
        this.embedText(content),
        this.embedImage(imageBase64, mimeType),
      ]);

      // Average the two embeddings (they should be same dimension)
      if (textEmbedding.length === imageEmbedding.length) {
        return textEmbedding.map((v, i) => (v + imageEmbedding[i]) / 2);
      }

      // If dimensions differ, just use text embedding
      return textEmbedding;
    }

    return this.embedText(content);
  }
}
