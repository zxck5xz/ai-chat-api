import type {
  MCPServerConnection,
  RemoteMCPTool,
  MCPCallLog,
  MCPInitializeResponse,
  MCPToolsListResponse,
  MCPToolCallResponse,
} from '../../types/mcp';

interface MCPClientConfig {
  db: D1Database;
}

export class MCPClient {
  private db: D1Database;

  constructor(config: MCPClientConfig) {
    this.db = config.db;
  }

  // === Server Connection Management ===

  async connectToServer(
    name: string,
    url: string,
    authToken: string
  ): Promise<MCPServerConnection> {
    const id = crypto.randomUUID();
    const authHash = await this.hashToken(authToken);

    // Try to initialize with the remote server
    let serverInfo: { name: string; version: string } | undefined;
    let protocolVersion = '2024-11-05';
    let status: 'connected' | 'error' = 'connected';
    let lastError: string | undefined;

    try {
      const initResponse = await this.sendRequest<{
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      }>(url, authToken, 'initialize', {
        protocolVersion,
        capabilities: { tools: {} },
        clientInfo: { name: 'ai-chat-api-mcp-client', version: '1.0.0' },
      });
      protocolVersion = initResponse.protocolVersion;
      serverInfo = initResponse.serverInfo;
    } catch (error) {
      status = 'error';
      lastError = error instanceof Error ? error.message : String(error);
    }

    // Save to database
    await this.db
      .prepare(
        `INSERT INTO connected_mcp_servers (id, name, url, auth_token_hash, protocol_version, server_info, status, last_error, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(
        id,
        name,
        url,
        authHash,
        protocolVersion,
        serverInfo ? JSON.stringify(serverInfo) : null,
        status,
        lastError || null
      )
      .run();

    // Cache tools if connected
    if (status === 'connected') {
      await this.refreshTools(id, url, authToken);
    }

    return {
      id,
      name,
      url,
      protocolVersion,
      serverInfo,
      status,
      lastError,
      createdAt: new Date().toISOString(),
    };
  }

  async disconnectServer(serverId: string): Promise<void> {
    await this.db.prepare('DELETE FROM connected_mcp_servers WHERE id = ?').bind(serverId).run();
  }

  async listServers(): Promise<MCPServerConnection[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM connected_mcp_servers ORDER BY created_at DESC')
      .all();

    return results.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      url: r.url as string,
      protocolVersion: r.protocol_version as string,
      serverInfo: r.server_info ? JSON.parse(r.server_info as string) : undefined,
      status: r.status as 'connected' | 'error' | 'disconnected',
      lastError: r.last_error as string | undefined,
      lastSeenAt: r.last_seen_at as string | undefined,
      createdAt: r.created_at as string,
    }));
  }

  async getServer(serverId: string): Promise<MCPServerConnection | undefined> {
    const result = await this.db
      .prepare('SELECT * FROM connected_mcp_servers WHERE id = ?')
      .bind(serverId)
      .first();

    if (!result) return undefined;

    return {
      id: result.id as string,
      name: result.name as string,
      url: result.url as string,
      protocolVersion: result.protocol_version as string,
      serverInfo: result.server_info ? JSON.parse(result.server_info as string) : undefined,
      status: result.status as 'connected' | 'error' | 'disconnected',
      lastError: result.last_error as string | undefined,
      lastSeenAt: result.last_seen_at as string | undefined,
      createdAt: result.created_at as string,
    };
  }

  // === Tool Management ===

  async refreshTools(
    serverId: string,
    url: string,
    authToken: string
  ): Promise<RemoteMCPTool[]> {
    try {
      const response = await this.sendRequest<MCPToolsListResponse>(
        url,
        authToken,
        'tools/list',
        {}
      );

      // Clear old tools for this server
      await this.db
        .prepare('DELETE FROM remote_mcp_tools WHERE server_id = ?')
        .bind(serverId)
        .run();

      // Insert new tools
      const tools: RemoteMCPTool[] = [];
      for (const tool of response.tools) {
        const id = crypto.randomUUID();
        await this.db
          .prepare(
            `INSERT INTO remote_mcp_tools (id, server_id, name, description, input_schema, cached_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(id, serverId, tool.name, tool.description, JSON.stringify(tool.inputSchema))
          .run();

        tools.push({
          id,
          serverId,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          cachedAt: new Date().toISOString(),
        });
      }

      // Update server last seen
      await this.db
        .prepare(
          `UPDATE connected_mcp_servers SET last_seen_at = datetime('now'), status = 'connected' WHERE id = ?`
        )
        .bind(serverId)
        .run();

      return tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .prepare(
          `UPDATE connected_mcp_servers SET status = 'error', last_error = ? WHERE id = ?`
        )
        .bind(message, serverId)
        .run();
      return [];
    }
  }

  async listTools(serverId: string): Promise<RemoteMCPTool[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM remote_mcp_tools WHERE server_id = ? ORDER BY name')
      .bind(serverId)
      .all();

    return results.map((r) => ({
      id: r.id as string,
      serverId: r.server_id as string,
      name: r.name as string,
      description: r.description as string,
      inputSchema: JSON.parse(r.input_schema as string),
      cachedAt: r.cached_at as string,
    }));
  }

  async getAllTools(): Promise<(RemoteMCPTool & { serverName: string })[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.*, s.name as server_name
         FROM remote_mcp_tools t
         JOIN connected_mcp_servers s ON t.server_id = s.id
         WHERE s.status = 'connected'
         ORDER BY s.name, t.name`
      )
      .all();

    return results.map((r) => ({
      id: r.id as string,
      serverId: r.server_id as string,
      name: r.name as string,
      description: r.description as string,
      inputSchema: JSON.parse(r.input_schema as string),
      cachedAt: r.cached_at as string,
      serverName: r.server_name as string,
    }));
  }

  // === Tool Execution ===

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResponse> {
    const server = await this.getServer(serverId);
    if (!server) {
      return {
        content: [{ type: 'text', text: `Server not found: ${serverId}` }],
        isError: true,
      };
    }

    const startTime = Date.now();
    let status: 'ok' | 'error' = 'ok';
    let resultSummary: string | undefined;
    let errorMessage: string | undefined;

    try {
      // We need the auth token - retrieve from DB (stored as hash, but we need original)
      // For security, we'll need the user to provide it or use a stored session token
      // For now, we'll use a placeholder approach
      const response = await this.sendRequest<MCPToolCallResponse>(
        server.url,
        '', // Auth token should be provided or cached
        'tools/call',
        { name: toolName, arguments: args }
      );

      const latencyMs = Date.now() - startTime;
      resultSummary = JSON.stringify(response).slice(0, 500);

      // Log the call
      await this.logCall(serverId, toolName, args, resultSummary, latencyMs, 'ok');

      return response;
    } catch (error) {
      status = 'error';
      errorMessage = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startTime;

      await this.logCall(serverId, toolName, args, undefined, latencyMs, 'error', errorMessage);

      return {
        content: [{ type: 'text', text: `Error calling tool: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  // === Call Logging ===

  private async logCall(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    resultSummary: string | undefined,
    latencyMs: number,
    status: 'ok' | 'error',
    errorMessage?: string
  ): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO mcp_call_log (id, server_id, tool_name, args_json, result_summary, latency_ms, status, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .bind(
        id,
        serverId,
        toolName,
        JSON.stringify(args),
        resultSummary || null,
        latencyMs,
        status,
        errorMessage || null
      )
      .run();
  }

  async getCallLog(
    serverId?: string,
    limit = 50
  ): Promise<MCPCallLog[]> {
    let query = 'SELECT * FROM mcp_call_log';
    const params: unknown[] = [];

    if (serverId) {
      query += ' WHERE server_id = ?';
      params.push(serverId);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const { results } = await this.db.prepare(query).bind(...params).all();

    return results.map((r) => ({
      id: r.id as string,
      serverId: r.server_id as string,
      toolName: r.tool_name as string,
      argsJson: r.args_json as string,
      resultSummary: r.result_summary as string | undefined,
      latencyMs: r.latency_ms as number,
      status: r.status as 'ok' | 'error',
      errorMessage: r.error_message as string | undefined,
      createdAt: r.created_at as string,
    }));
  }

  async getStats(): Promise<{
    totalServers: number;
    connectedServers: number;
    totalTools: number;
    totalCalls: number;
    successRate: number;
    avgLatencyMs: number;
    callsByServer: { serverId: string; serverName: string; count: number }[];
    callsByTool: { toolName: string; count: number; avgLatencyMs: number }[];
  }> {
    const [servers, tools, callStats, byServerResult, byToolResult] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM connected_mcp_servers').first(),
      this.db.prepare('SELECT COUNT(*) as count FROM remote_mcp_tools').first(),
      this.db
        .prepare(
          `SELECT
             COUNT(*) as total,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as success,
             AVG(latency_ms) as avg_latency
           FROM mcp_call_log`
        )
        .first(),
      this.db
        .prepare(
          `SELECT s.id as server_id, s.name as server_name, COUNT(l.id) as count
           FROM connected_mcp_servers s
           LEFT JOIN mcp_call_log l ON s.id = l.server_id
           GROUP BY s.id
           ORDER BY count DESC`
        )
        .all<{ server_id: string; server_name: string; count: number }>(),
      this.db
        .prepare(
          `SELECT tool_name, COUNT(*) as count, AVG(latency_ms) as avg_latency
           FROM mcp_call_log
           GROUP BY tool_name
           ORDER BY count DESC`
        )
        .all<{ tool_name: string; count: number; avg_latency: number }>(),
    ]);

    const byServer = byServerResult.results || [];
    const byTool = byToolResult.results || [];

    return {
      totalServers: (servers?.count as number) || 0,
      connectedServers: (
        await this.db
          .prepare("SELECT COUNT(*) as count FROM connected_mcp_servers WHERE status = 'connected'")
          .first()
      )?.count as number || 0,
      totalTools: (tools?.count as number) || 0,
      totalCalls: (callStats?.total as number) || 0,
      successRate:
        (callStats?.total as number) > 0
          ? ((callStats?.success as number) / (callStats?.total as number)) * 100
          : 100,
      avgLatencyMs: (callStats?.avg_latency as number) || 0,
      callsByServer: byServer.map((r) => ({
        serverId: r.server_id,
        serverName: r.server_name,
        count: r.count,
      })),
      callsByTool: byTool.map((r) => ({
        toolName: r.tool_name,
        count: r.count,
        avgLatencyMs: r.avg_latency,
      })),
    };
  }

  // === Helpers ===

  private async sendRequest<T>(
    url: string,
    authToken: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (body.error) {
      throw new Error(`MCP error: ${body.error.message}`);
    }

    return body.result as T;
  }

  private async hashToken(token: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
