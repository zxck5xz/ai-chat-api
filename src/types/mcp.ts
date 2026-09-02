// MCP Protocol Types
// Based on Model Context Protocol specification

// === MCP Server Types (we expose tools) ===

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, MCPToolProperty>;
    required?: string[];
  };
}

export interface MCPToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

export interface MCPToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolCallResponse {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    name: string;
    mimeType?: string;
  };
}

// === MCP Client Types (we consume external tools) ===

export interface MCPServerConnection {
  id: string;
  name: string;
  url: string;
  protocolVersion: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  status: 'connected' | 'error' | 'disconnected';
  lastError?: string;
  lastSeenAt?: string;
  createdAt: string;
}

export interface RemoteMCPTool {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  cachedAt: string;
}

export interface MCPCallLog {
  id: string;
  serverId: string;
  toolName: string;
  argsJson: string;
  resultSummary?: string;
  latencyMs: number;
  status: 'ok' | 'error';
  errorMessage?: string;
  createdAt: string;
}

// === MCP Protocol Messages ===

export interface MCPInitializeRequest {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface MCPInitializeResponse {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface MCPToolsListResponse {
  tools: MCPToolDefinition[];
}

// === Dashboard Types ===

export interface MCPDashboardStats {
  totalServers: number;
  connectedServers: number;
  totalTools: number;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  callsByServer: { serverId: string; serverName: string; count: number }[];
  callsByTool: { toolName: string; count: number; avgLatencyMs: number }[];
  recentCalls: MCPCallLog[];
}

// === Internal Tool Registry (wraps existing services) ===

export interface InternalTool {
  name: string;
  description: string;
  category: 'search' | 'rag' | 'code-review' | 'multi-modal' | 'orchestrator' | 'utility';
  inputSchema: MCPToolDefinition['inputSchema'];
  handler: (args: Record<string, unknown>, env: unknown) => Promise<MCPToolCallResponse>;
}
