export interface EpisodicMemory {
  id: string;
  user_id: string;
  conversation_id: string | null;
  content: string;
  summary: string;
  topics: string;
  outcome: 'positive' | 'negative' | 'neutral';
  sentiment: number;
  importance: number;
  access_count: number;
  last_accessed_at: string;
  strength: number;
  consolidated: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface SemanticMemory {
  id: string;
  user_id: string;
  fact: string;
  category: string;
  confidence: number;
  source_episodic_id: string | null;
  source_type: 'extracted' | 'consolidated' | 'user_provided';
  access_count: number;
  last_accessed_at: string;
  strength: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeGraphNode {
  id: string;
  user_id: string;
  name: string;
  type: string;
  description: string;
  properties: string;
  strength: number;
  access_count: number;
  last_accessed_at: string;
  created_at: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  user_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  weight: number;
  metadata: string;
  created_at: string;
}

export interface MemoryConsolidation {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  episodic_count: number;
  semantic_created: number;
  nodes_created: number;
  edges_created: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface MemoryAccessLog {
  id: string;
  user_id: string;
  memory_type: 'episodic' | 'semantic' | 'knowledge_graph';
  memory_id: string;
  query: string;
  relevance_score: number;
  used_in_response: number;
  created_at: string;
}

export interface MemorySearchResult {
  type: 'episodic' | 'semantic' | 'knowledge_graph';
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryMetrics {
  total_episodic: number;
  total_semantic: number;
  total_nodes: number;
  total_edges: number;
  avg_episodic_strength: number;
  avg_semantic_strength: number;
  memory_hit_rate: number;
  total_accesses: number;
  consolidated_count: number;
  pending_consolidation: number;
  memory_types_breakdown: { type: string; count: number }[];
  recent_accesses: MemoryAccessLog[];
}

export interface CreateEpisodicInput {
  user_id: string;
  conversation_id?: string;
  content: string;
  summary?: string;
  topics?: string[];
  outcome?: 'positive' | 'negative' | 'neutral';
  sentiment?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateSemanticInput {
  user_id: string;
  fact: string;
  category?: string;
  confidence?: number;
  source_episodic_id?: string;
  source_type?: 'extracted' | 'consolidated' | 'user_provided';
  metadata?: Record<string, unknown>;
}

export interface CreateGraphNodeInput {
  user_id: string;
  name: string;
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
}

export interface CreateGraphEdgeInput {
  user_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}
