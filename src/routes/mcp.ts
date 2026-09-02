import { Hono } from 'hono';
import type { Env } from '../types';
import { getMCPToolDefinitions, executeTool } from '../services/mcp/server';
import { MCPClient } from '../services/mcp/client';

const mcp = new Hono<{ Bindings: Env }>();

function getClient(env: Env): MCPClient {
  return new MCPClient({ db: env.DB });
}

// ============================================
// MCP Server Endpoints (expose our tools)
// ============================================

// MCP Server: Initialize
mcp.post('/server/initialize', async (c) => {
  return c.json({
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'ai-chat-api',
      version: '1.0.0',
    },
  });
});

// MCP Server: List available tools
mcp.get('/server/tools', (c) => {
  const tools = getMCPToolDefinitions();
  return c.json({ tools });
});

// MCP Server: Call a tool
mcp.post('/server/call', async (c) => {
  try {
    const body = await c.req.json<{ name: string; arguments: Record<string, unknown> }>();
    const { name, arguments: args } = body;

    if (!name) {
      return c.json({ error: 'Tool name is required' }, 400);
    }

    const result = await executeTool({ name, arguments: args || {} }, c.env);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Tool call failed', details: message }, 500);
  }
});

// ============================================
// MCP Client Endpoints (consume external tools)
// ============================================

// List connected servers
mcp.get('/client/servers', async (c) => {
  const client = getClient(c.env);
  const servers = await client.listServers();
  return c.json({ servers });
});

// Get a specific server
mcp.get('/client/servers/:id', async (c) => {
  const client = getClient(c.env);
  const server = await client.getServer(c.req.param('id'));
  if (!server) {
    return c.json({ error: 'Server not found' }, 404);
  }
  return c.json({ server });
});

// Connect to a new MCP server
mcp.post('/client/servers', async (c) => {
  try {
    const body = await c.req.json<{ name: string; url: string; authToken: string }>();
    const { name, url, authToken } = body;

    if (!name || !url) {
      return c.json({ error: 'name and url are required' }, 400);
    }

    const client = getClient(c.env);
    const server = await client.connectToServer(name, url, authToken || '');
    return c.json({ server }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to connect to server', details: message }, 500);
  }
});

// Disconnect from a server
mcp.delete('/client/servers/:id', async (c) => {
  const client = getClient(c.env);
  await client.disconnectServer(c.req.param('id'));
  return c.json({ success: true });
});

// Refresh tools from a server
mcp.post('/client/servers/:id/refresh', async (c) => {
  try {
    const client = getClient(c.env);
    const server = await client.getServer(c.req.param('id'));
    if (!server) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const tools = await client.refreshTools(server.id, server.url, '');
    return c.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to refresh tools', details: message }, 500);
  }
});

// List tools from a specific server
mcp.get('/client/servers/:id/tools', async (c) => {
  const client = getClient(c.env);
  const tools = await client.listTools(c.req.param('id'));
  return c.json({ tools });
});

// List all tools from all connected servers
mcp.get('/client/tools', async (c) => {
  const client = getClient(c.env);
  const tools = await client.getAllTools();
  return c.json({ tools });
});

// Call a tool on a remote server
mcp.post('/client/call', async (c) => {
  try {
    const body = await c.req.json<{
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }>();
    const { serverId, toolName, arguments: args } = body;

    if (!serverId || !toolName) {
      return c.json({ error: 'serverId and toolName are required' }, 400);
    }

    const client = getClient(c.env);
    const result = await client.callTool(serverId, toolName, args || {});
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Tool call failed', details: message }, 500);
  }
});

// Get call log
mcp.get('/client/log', async (c) => {
  const client = getClient(c.env);
  const serverId = c.req.query('serverId') || undefined;
  const limit = parseInt(c.req.query('limit') || '50');
  const log = await client.getCallLog(serverId, limit);
  return c.json({ log });
});

// Get dashboard stats
mcp.get('/client/stats', async (c) => {
  const client = getClient(c.env);
  const stats = await client.getStats();
  return c.json({ stats });
});

export default mcp;
