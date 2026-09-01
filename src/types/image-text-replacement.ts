export interface TextRegion {
  id: string;
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  fontSize?: string;
  fontFamily?: string;
  color?: string;
}

export interface OCRResult {
  id: string;
  regions: TextRegion[];
  fullText: string;
  imageWidth: number;
  imageHeight: number;
  latencyMs: number;
  model: string;
  created_at: string;
}

export interface TextReplacementRequest {
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
}

export interface TextReplacementResult {
  id: string;
  originalImageUrl: string;
  editedImageUrl: string;
  replacements: Array<{
    regionId: string;
    originalText: string;
    newText: string;
    status: 'success' | 'failed';
  }>;
  latencyMs: number;
  model: string;
  created_at: string;
}

export interface ImageTextMetrics {
  totalReplacements: number;
  successRate: number;
  avgLatencyMs: number;
  totalRegionsDetected: number;
}
