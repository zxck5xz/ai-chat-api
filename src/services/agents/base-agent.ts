import type { AgentResult } from '../../types/agents';

export interface AgentConfig {
  apiKey: string;
  model: string;
}

export abstract class BaseAgent {
  protected apiKey: string;
  protected model: string;

  constructor(config: AgentConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  abstract readonly type: string;
  abstract readonly systemPrompt: string;

  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        // Exponential backoff: 5s, 10s, 20s, 40s, 80s
        const baseDelay = 5000;
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : baseDelay * Math.pow(2, attempt);
        console.log(`[${this.type}] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms...`);
        await this.sleep(delay);
        continue;
      }
      
      return response;
    }
    
    throw new Error('Max retries exceeded - Gemini API quota exhausted');
  }

  async run(input: string, context?: string): Promise<AgentResult> {
    try {
      const prompt = context ? `${this.systemPrompt}\n\nContext:\n${context}` : this.systemPrompt;

      const response = await this.fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompt }] },
            contents: [{ role: 'user', parts: [{ text: input }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${err}`);
      }

      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      console.log(`[${this.type}] Response length:`, text?.length || 0);
      if (this.type === 'coder') {
        console.log(`[coder] Full response:`, text);
      }

      if (!text) {
        throw new Error('No response from model');
      }

      return { success: true, output: text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: message };
    }
  }

  async runStream(
    input: string,
    context?: string,
    onToken?: (token: string) => void
  ): Promise<AgentResult> {
    try {
      const prompt = context ? `${this.systemPrompt}\n\nContext:\n${context}` : this.systemPrompt;

      const response = await this.fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompt }] },
            contents: [{ role: 'user', parts: [{ text: input }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 8192,
            },
          }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${err}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      if (!reader) throw new Error('No readable stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                fullText += text;
                onToken?.(text);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      return { success: true, output: fullText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: message };
    }
  }
}
