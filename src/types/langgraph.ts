/**
 * LangGraph API Types
 */

export interface GraphRunRequest {
  pattern: 'supervisor' | 'swarm' | 'hierarchical' | 'custom';
  task: string;
  threadId?: string;
  requireApproval?: boolean;
  config?: Record<string, any>;
}

export interface GraphRunResponse {
  threadId: string;
  status: 'completed' | 'error' | 'awaiting_approval';
  result: Record<string, any>;
  trace: {
    graphName: string;
    nodes: Array<{
      nodeId: string;
      duration: number;
      error?: string;
    }>;
    totalDuration: number;
  };
  cost?: {
    totalUsd: number;
    byModel: Record<string, number>;
    byNode: Record<string, number>;
  };
}

export interface ApprovalAction {
  approvalId: string;
  status: 'approved' | 'rejected';
  response?: string;
}

export interface GraphState {
  threadId: string;
  pattern: string;
  task: string;
  state: Record<string, any>;
  status: string;
  createdAt: number;
  completedAt?: number;
}
