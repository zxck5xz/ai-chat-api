import type { STTResult } from '../../types/voice-agent';

export interface STTService {
  transcribe(audioBase64: string, options?: { language?: string; format?: string }): Promise<STTResult>;
}

export class WhisperSTT implements STTService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(
    audioBase64: string,
    options?: { language?: string; format?: string }
  ): Promise<STTResult> {
    const startTime = Date.now();

    const formData = new FormData();
    const audioBytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([audioBytes], { type: options?.format || 'audio/webm' });
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');

    if (options?.language) {
      formData.append('language', options.language);
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper STT failed: ${response.status} - ${error}`);
    }

    const result = await response.json() as {
      text: string;
      language: string;
      duration: number;
      segments?: { start: number; end: number; text: string }[];
    };

    return {
      text: result.text,
      language: result.language || options?.language || 'en',
      durationMs: Date.now() - startTime,
      segments: result.segments,
    };
  }
}

export class MockSTT implements STTService {
  async transcribe(
    _audioBase64: string,
    options?: { language?: string }
  ): Promise<STTResult> {
    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 700));

    const mockTexts = [
      'What is the weather today?',
      'Can you help me with this code?',
      'Tell me about artificial intelligence.',
      'How does machine learning work?',
      'What are the benefits of cloud computing?',
    ];

    return {
      text: mockTexts[Math.floor(Math.random() * mockTexts.length)],
      language: options?.language || 'en',
      durationMs: 500 + Math.random() * 1000,
    };
  }
}
