export type AgentType = 'planner' | 'designer' | 'coder' | 'reviewer';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_approval';

export interface AgentTask {
  id: string;
  agent: AgentType;
  status: TaskStatus;
  input: string;
  output: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  metadata?: unknown;
}

export interface WorkflowRun {
  id: string;
  requestId: string;
  userInput: string;
  tasks: AgentTask[];
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval';
  createdAt: string;
  completedAt?: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowEvent {
  type: 'task_start' | 'task_complete' | 'task_error' | 'approval_needed' | 'workflow_complete' | 'token';
  taskId?: string;
  agent?: AgentType;
  content?: string;
  error?: string;
  approvalId?: string;
}
