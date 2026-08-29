export type AnalysisType = 'describe' | 'ocr' | 'compare' | 'chart' | 'code_screenshot' | 'receipt' | 'document' | 'custom';

export interface ImageAnalysisRequest {
  imageBase64: string;
  mimeType: string;
  prompt?: string;
  analysisType: AnalysisType;
  language?: string;
}

export interface ImageAnalysisResult {
  id: string;
  analysisType: AnalysisType;
  description: string;
  extractedText?: string;
  structuredData?: Record<string, unknown>;
  confidence: number;
  latencyMs: number;
  model: string;
  tokensUsed: number;
  costUsd: number;
  created_at: string;
}

export interface DocumentUnderstandingRequest {
  documentBase64: string;
  mimeType: string;
  pages?: number[];
  extractTables?: boolean;
  extractImages?: boolean;
}

export interface DocumentPage {
  pageNumber: number;
  text: string;
  tables?: TableData[];
  images?: ExtractedImage[];
  layout?: PageLayout;
}

export interface TableData {
  headers: string[];
  rows: string[][];
  confidence: number;
}

export interface ExtractedImage {
  index: number;
  description: string;
  position: { x: number; y: number; width: number; height: number };
}

export interface PageLayout {
  width: number;
  height: number;
  columns: number;
  hasHeader: boolean;
  hasFooter: boolean;
}

export interface DocumentUnderstandingResult {
  id: string;
  totalPages: number;
  pages: DocumentPage[];
  fullText: string;
  summary: string;
  metadata: {
    title?: string;
    author?: string;
    createdAt?: string;
    pageCount: number;
    wordCount: number;
  };
  latencyMs: number;
  model: string;
  created_at: string;
}

export interface ComparisonRequest {
  imageBase64A: string;
  imageBase64B: string;
  mimeType: string;
  prompt?: string;
}

export interface ComparisonResult {
  id: string;
  similarities: string[];
  differences: string[];
  summary: string;
  sideBySideDescription: string;
  latencyMs: number;
  model: string;
  created_at: string;
}

export interface MultiModalChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: ChatImage[];
  timestamp: string;
}

export interface ChatImage {
  id: string;
  base64: string;
  mimeType: string;
  thumbnail?: string;
  analysis?: ImageAnalysisResult;
}

export interface MultiModalChatSession {
  id: string;
  messages: MultiModalChatMessage[];
  createdAt: string;
}

export interface MultiModalMetrics {
  totalAnalyses: number;
  analysesByType: Record<AnalysisType, number>;
  avgLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  topModels: { model: string; count: number }[];
}
