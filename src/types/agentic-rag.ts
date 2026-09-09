export type RetrievalDecision = 'skip' | 'retrieve' | 'ambiguous';
export type QueryIntent = 'factual' | 'analytical' | 'comparative' | 'exploratory' | 'creative' | 'chitchat' | 'code' | 'math';
export type RetrievalStrategy = 'single' | 'multi_round' | 'decompose' | 'step_back';

export interface QueryAnalysis {
  originalQuery: string;
  needsRetrieval: RetrievalDecision;
  decisionConfidence: number;
  decisionReasoning: string;
  intent: QueryIntent;
  complexity: number;
  subQuestions: string[];
  retrievalStrategy: RetrievalStrategy;
  suggestedTopK: number;
  maxRetrievalRounds: number;
  keywords: string[];
  entities: string[];
}

export interface RetrievalRound {
  roundNumber: number;
  query: string;
  strategy: string;
  chunksRetrieved: number;
  avgRelevanceScore: number;
  topScore: number;
  latencyMs: number;
}

export interface ConfidenceEvaluation {
  score: number;
  reasoning: string;
  hasHallucination: boolean;
  citationCoverage: number;
  contradictionsFound: number;
  needsRegeneration: boolean;
  needsMoreRetrieval: boolean;
}

export interface AgenticRAGStep {
  stepNumber: number;
  type: 'classify' | 'retrieve' | 'generate' | 'evaluate' | 'correct' | 'synthesize';
  query: string;
  input: string;
  output: string;
  latencyMs: number;
  metadata: Record<string, unknown>;
}

export interface AgenticRAGRun {
  id: string;
  query: string;
  analysis: QueryAnalysis;
  rounds: RetrievalRound[];
  steps: AgenticRAGStep[];
  finalAnswer: string;
  confidence: ConfidenceEvaluation;
  totalRounds: number;
  totalLatencyMs: number;
  status: 'completed' | 'failed' | 'timeout';
  createdAt: string;
  completedAt: string;
}

export interface AgenticRAGEvent {
  type: 'analysis' | 'retrieval' | 'generation' | 'evaluation' | 'correction' | 'answer' | 'error';
  data: Record<string, unknown>;
  timestamp: string;
}
