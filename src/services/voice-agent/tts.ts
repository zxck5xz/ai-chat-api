import type { TTSResult } from '../../types/voice-agent';

export interface TTSProvider {
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  synthesizeStream(text: string, options?: TTSOptions): AsyncGenerator<TTSStreamChunk>;
}

export interface TTSOptions {
  voiceId?: string;
  language?: string;
  speed?: number;
  pitch?: number;
}

export interface TTSStreamChunk {
  audioBase64: string;
  format: string;
  isLast: boolean;
}

export class ElevenLabsTTS implements TTSProvider {
  private apiKey: string;
  private defaultVoiceId: string;

  constructor(apiKey: string, defaultVoiceId?: string) {
    this.apiKey = apiKey;
    this.defaultVoiceId = defaultVoiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const startTime = Date.now();
    const voiceId = options?.voiceId || this.defaultVoiceId;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: options?.speed || 1.0,
            pitch: options?.pitch || 1.0,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS failed: ${response.status} - ${error}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const audioBase64 = btoa(
      new Uint8Array(audioBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ''
      )
    );

    return {
      audioBase64,
      format: 'audio/mpeg',
      durationMs: Date.now() - startTime,
      characterCount: text.length,
    };
  }

  async *synthesizeStream(
    text: string,
    options?: TTSOptions
  ): AsyncGenerator<TTSStreamChunk> {
    const voiceId = options?.voiceId || this.defaultVoiceId;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: options?.speed || 1.0,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS stream failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let isDone = false;

    while (!isDone) {
      const { done, value } = await reader.read();
      isDone = done;

      if (!isDone && value) {
        const audioBase64 = btoa(
          new Uint8Array(value).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );
        yield {
          audioBase64,
          format: 'audio/mpeg',
          isLast: false,
        };
      }
    }

    yield { audioBase64: '', format: 'audio/mpeg', isLast: true };
  }
}

export class OpenAITTS implements TTSProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const startTime = Date.now();

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options?.voiceId || 'alloy',
        speed: options?.speed || 1.0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const audioBase64 = btoa(
      new Uint8Array(audioBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ''
      )
    );

    return {
      audioBase64,
      format: 'audio/mpeg',
      durationMs: Date.now() - startTime,
      characterCount: text.length,
    };
  }

  async *synthesizeStream(
    text: string,
    options?: TTSOptions
  ): AsyncGenerator<TTSStreamChunk> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: options?.voiceId || 'alloy',
        speed: options?.speed || 1.0,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS stream failed: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let isDone = false;

    while (!isDone) {
      const { done, value } = await reader.read();
      isDone = done;

      if (!isDone && value) {
        const audioBase64 = btoa(
          new Uint8Array(value).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );
        yield {
          audioBase64,
          format: 'audio/mpeg',
          isLast: false,
        };
      }
    }

    yield { audioBase64: '', format: 'audio/mpeg', isLast: true };
  }
}

export class MockTTS implements TTSProvider {
  async synthesize(text: string, _options?: TTSOptions): Promise<TTSResult> {
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 500));

    return {
      audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
      format: 'audio/mpeg',
      durationMs: text.length * 50,
      characterCount: text.length,
    };
  }

  async *synthesizeStream(
    text: string,
    options?: TTSOptions
  ): AsyncGenerator<TTSStreamChunk> {
    const chunkSize = 50;
    const totalChunks = Math.ceil(text.length / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield {
        audioBase64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
        format: 'audio/mpeg',
        isLast: i === totalChunks - 1,
      };
    }
  }
}
