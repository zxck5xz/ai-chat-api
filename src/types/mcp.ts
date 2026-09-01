/**
 * Model Context Protocol (MCP) types — minimal subset aligned with the
 * JSON-RPC 2.0 wire format used by MCP clients (Claude Desktop, Cursor,
 * MCP CLI). We implement server-side: initialize, tools/list, tools/call,
 * resources/list, resources/read.
 *
 * Spec reference: https://modelcontextprotocol.io
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: R;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes plus MCP-specific extensions
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // MCP-specific (custom range starts at -32000)
  Unauthorized: -32001,
  ToolNotFound: -32002,
  ToolExecutionError: -32003,
} as const;

// ---------------------------------------------------------------------------
// MCP initialize
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  sampling?: Record<string, never>;
  roots?: { listChanged?: boolean };
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: { name: string; version: string };
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema for a tool's input object. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export interface ListToolsResult {
  tools: Tool[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string };

export interface CallToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Resources (read-only context providers)
// ---------------------------------------------------------------------------

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ListResourcesResult {
  resources: Resource[];
}

export interface ReadResourceParams {
  uri: string;
}

export interface ReadResourceResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Internal: tool handler signature (server-side)
// ---------------------------------------------------------------------------

import type { Env } from '../types';

export type ToolHandler = (
  args: Record<string, unknown>,
  env: Env
) => Promise<CallToolResult>;

export interface RegisteredTool {
  tool: Tool;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// Client-side (talking to remote MCP servers)
// ---------------------------------------------------------------------------

export interface RemoteMcpServer {
  id: string;
  name: string;
  url: string;
  authTokenHash: string;
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  status: 'connected' | 'error' | 'disconnected';
  lastSeenAt?: string;
  createdAt: string;
}

export interface RemoteMcpTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}