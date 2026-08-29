export type QueryComplexity = 'simple' | 'moderate' | 'complex' | 'ambiguous';

export interface ClassifiedQuery {
  originalQuery: string;
  complexity: QueryComplexity;
  confidence: number;
  reasoning: string;
  keywords: string[];
  entities: string[];
}

export interface ExpandedQuery {
  originalQuery: string;
  strategy: 'hyde' | 'multi_query' | 'decomposition' | 'step_back' | 'alias_only';
  expandedQueries: string[];
  hydeDocument?: string;
  subQuestions?: string[];
  latencyMs: number;
}

export interface RewrittenQuery {
  originalQuery: string;
  rewrittenQuery: string;
  contextInjected: boolean;
  pronounsResolved: string[];
  chatHistoryUsed: number;
}

export interface QueryUnderstandingResult {
  classified: ClassifiedQuery;
  expanded: ExpandedQuery;
  rewritten: RewrittenQuery;
  finalQueries: string[];
  totalLatencyMs: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SearchQuery {
  id: string;
  query: string;
  expanded_query?: string;
  complexity: QueryComplexity;
  strategy: string;
  results_count: number;
  clicked_result_id?: string;
  clicked_position?: number;
  latency_ms: number;
  created_at: string;
}

export interface SearchClick {
  id: string;
  query_id: string;
  result_id: string;
  position: number;
  document_id: string;
  chunk_id?: string;
  created_at: string;
}

export interface SearchFeedback {
  id: string;
  query_id: string;
  rating: 'positive' | 'negative';
  comment?: string;
  created_at: string;
}

export interface SearchAnalytics {
  totalQueries: number;
  avgLatencyMs: number;
  ctr: number;
  mrr: number;
  zeroClickRate: number;
  queriesByComplexity: Record<QueryComplexity, number>;
  topQueries: { query: string; count: number; ctr: number }[];
  worstQueries: { query: string; count: number; ctr: number; avgPosition: number }[];
  clicksByPosition: { position: number; count: number }[];
}

export interface SearchResult {
  id: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
  rerankScore?: number;
  metadata?: Record<string, unknown>;
}
