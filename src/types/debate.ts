// Project 17: Multi-Agent Debate & Verifier Types

export type DebateFormat = 'oxford' | 'lincoln_douglas' | 'free_form';

export type AgentRole = 'debater_for' | 'debater_against' | 'debater_nuanced' | 'judge' | 'fact_checker';

export type ArgumentPosition = 'for' | 'against' | 'nuanced';

export type RoundType = 'opening' | 'rebuttal' | 'closing';

export type ClaimVerdict = 'supported' | 'unsupported' | 'contradicted' | 'unverifiable';

export type DebateStatus = 'pending' | 'debating' | 'judging' | 'fact_checking' | 'consensus' | 'completed' | 'failed';

export interface Claim {
  id: string;
  text: string;
  source?: string;
  verdict: ClaimVerdict;
  confidence: number;
  explanation: string;
}

export interface Argument {
  id: string;
  debater_id: string;
  position: ArgumentPosition;
  round: RoundType;
  content: string;
  claims: Claim[];
  evidence_count: number;
  strength_score: number;
  created_at: string;
}

export interface DebaterResult {
  agent_id: string;
  position: ArgumentPosition;
  arguments: Argument[];
  overall_score: number;
}

export interface JudgeVerdict {
  winner: ArgumentPosition;
  reasoning: string;
  scores: {
    position: ArgumentPosition;
    argumentation: number;
    evidence: number;
    persuasiveness: number;
    rebuttal_effectiveness: number;
    overall: number;
  }[];
}

export interface FactCheckResult {
  total_claims: number;
  supported: number;
  unsupported: number;
  contradicted: number;
  unverifiable: number;
  accuracy_rate: number;
  claims: Claim[];
}

export interface ConsensusResult {
  synthesis: string;
  key_points: string[];
  areas_of_agreement: string[];
  areas_of_disagreement: string[];
  confidence: number;
}

export interface DebateRun {
  id: string;
  question: string;
  format: DebateFormat;
  status: DebateStatus;
  debaters: DebaterResult[];
  judge_verdict: JudgeVerdict | null;
  fact_check: FactCheckResult | null;
  consensus: ConsensusResult | null;
  total_rounds: number;
  total_claims: number;
  accuracy_rate: number;
  duration_ms: number;
  created_at: string;
  completed_at: string | null;
}

export interface DebateMetrics {
  total_debates: number;
  avg_duration_ms: number;
  avg_accuracy_rate: number;
  avg_claims_per_debate: number;
  format_breakdown: Record<DebateFormat, number>;
  position_win_rates: Record<ArgumentPosition, number>;
  recent_debates: DebateRun[];
}

export interface DebateEvent {
  type: 'debater_start' | 'argument' | 'judge_start' | 'verdict' | 'fact_check_start' | 'fact_check' | 'consensus_start' | 'consensus' | 'complete' | 'error';
  data: Record<string, unknown>;
  timestamp?: string;
}
