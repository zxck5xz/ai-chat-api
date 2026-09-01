export interface GenerateImageRequest {
  imageBase64: string;
  mimeType: string;
  prompt: string;
}

export class ImageGenerator {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash-exp';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  async generateImage(request: GenerateImageRequest): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: request.prompt },
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
            responseModalities: ['IMAGE', 'TEXT'],
            temperature: 0.4,
          },
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini image generation error: ${response.status} - ${errBody}`);
    }

    const data = await response.json() as {
      candidates: Array<{
        content: {
          parts: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
      }>;
    };

    const parts = data.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        return part.inlineData.data;
      }
    }

    throw new Error('No image was generated in the response');
  }

  buildReplacementPrompt(
    replacements: Array<{ originalText: string; newText: string }>,
    style?: { fontSize?: string; fontFamily?: string; color?: string }
  ): string {
    const replacementDesc = replacements
      .map((r) => `Replace "${r.originalText}" with "${r.newText}"`)
      .join('. ');

    const styleDesc = style
      ? ` Use ${style.fontSize || 'similar'} font size${style.color ? `, color ${style.color}` : ''}${style.fontFamily ? `, font ${style.fontFamily}` : ''}.`
      : '';

    return `Edit this image by replacing specific text regions.

Instructions:
1. Keep the image exactly the same except for the text changes
2. ${replacementDesc}${styleDesc}
3. Maintain the same visual style, positioning, and layout
4. Do not change any other elements in the image
5. The replaced text should look natural and match the surrounding design

Output the edited image.`;
  }
}
