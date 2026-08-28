import { getGeminiTools, getToolByName } from './tools';
import type { ToolAgentRun, ToolAgentStep, ToolCall, ToolAgentEvent } from '../../types/tool-agent';

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools. You can search the web, make HTTP requests, do calculations, and get the current time.

When you need information, use your tools. Think step by step:
1. Consider what information you need
2. Use the appropriate tool(s) to get it
3. Analyze the results
4. Provide a comprehensive answer

Always explain your reasoning. If a tool fails, try an alternative approach.
When comparing things (like prices), search for each one and then summarize the comparison.`;

export class ToolAgent {
  private apiKey: string;
  private model: string;
  private maxSteps: number;
  private db?: D1Database;

  constructor(config: { apiKey: string; model?: string; maxSteps?: number; db?: D1Database }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-2.5-flash';
    this.maxSteps = config.maxSteps || 10;
    this.db = config.db;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const delay = 5000 * Math.pow(2, attempt);
        console.log(`[ToolAgent] Rate limited, waiting ${delay}ms...`);
        await this.sleep(delay);
        continue;
      }
      return response;
    }
    throw new Error('Max retries exceeded');
  }

  private async saveRun(run: ToolAgentRun): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.prepare(
        `INSERT OR REPLACE INTO tool_agent_runs (id, query, steps, final_answer, status, total_tool_calls, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        run.id,
        run.query,
        JSON.stringify(run.steps),
        run.finalAnswer,
        run.status,
        run.totalToolCalls,
        run.createdAt,
        run.completedAt || null
      ).run();
    } catch (err) {
      console.error('[ToolAgent] Failed to save run:', err);
    }
  }

  async run(
    query: string,
    onEvent: (event: ToolAgentEvent) => void
  ): Promise<ToolAgentRun> {
    const runId = crypto.randomUUID();
    const run: ToolAgentRun = {
      id: runId,
      query,
      steps: [],
      finalAnswer: '',
      status: 'running',
      createdAt: new Date().toISOString(),
      totalToolCalls: 0,
    };

    // Save initial run state
    await this.saveRun(run);

    // Conversation history for multi-turn function calling
    const conversationParts: Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }> = [];

    try {
      // Initial user message
      conversationParts.push({
        role: 'user',
        parts: [{ text: query }],
      });

      for (let stepIndex = 0; stepIndex < this.maxSteps; stepIndex++) {
        const step: ToolAgentStep = { thought: '', toolCalls: [] };

        onEvent({ type: 'step_start', stepIndex });

        // Call Gemini with tools
        const response = await this.fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: conversationParts,
              tools: getGeminiTools(),
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192,
              },
            }),
          }
        );

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Gemini API error: ${response.status} - ${err}`);
        }

        const data = await response.json() as {
          candidates?: {
            content?: {
              parts?: Array<{
                text?: string;
                functionCall?: { name: string; args: Record<string, unknown> };
              }>;
              role?: string;
            };
          }[];
        };

        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        // Extract text and function calls
        let textContent = '';
        const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

        for (const part of parts) {
          if (part.text) {
            textContent += part.text;
          }
          if (part.functionCall) {
            functionCalls.push(part.functionCall);
          }
        }

        // If there's text, it's the model's thought or final answer
        if (textContent) {
          step.thought = textContent;
          onEvent({ type: 'thinking', stepIndex, thought: textContent });
        }

        // If no function calls, this is the final answer
        if (functionCalls.length === 0) {
          run.finalAnswer = textContent;
          run.status = 'completed';
          run.completedAt = new Date().toISOString();

          await this.saveRun(run);

          onEvent({
            type: 'final_answer',
            stepIndex,
            content: textContent,
          });
          onEvent({
            type: 'run_complete',
            run: { ...run },
          });

          return run;
        }

        // Add model response to conversation
        conversationParts.push({
          role: 'model',
          parts: parts.map((p) => {
            if (p.functionCall) return { functionCall: p.functionCall };
            return { text: p.text || '' };
          }),
        });

        // Execute each function call
        const functionResponses: Array<{
          functionResponse: { name: string; response: { result: string } };
        }> = [];

        for (const fc of functionCalls) {
          const toolCall: ToolCall = {
            id: crypto.randomUUID(),
            name: fc.name,
            input: fc.args,
            output: '',
            status: 'running',
            startedAt: new Date().toISOString(),
          };
          step.toolCalls.push(toolCall);
          run.totalToolCalls++;

          onEvent({
            type: 'tool_call',
            stepIndex,
            toolCall: { ...toolCall },
          });

          const tool = getToolByName(fc.name);
          if (!tool) {
            toolCall.status = 'failed';
            toolCall.error = `Unknown tool: ${fc.name}`;
            toolCall.completedAt = new Date().toISOString();
            functionResponses.push({
              functionResponse: {
                name: fc.name,
                response: { result: `Error: Unknown tool "${fc.name}"` },
              },
            });
            continue;
          }

          try {
            const result = await tool.execute(fc.args);
            toolCall.output = result;
            toolCall.status = 'completed';
            toolCall.completedAt = new Date().toISOString();

            onEvent({
              type: 'tool_result',
              stepIndex,
              toolName: fc.name,
              toolOutput: result,
            });

            functionResponses.push({
              functionResponse: {
                name: fc.name,
                response: { result },
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toolCall.status = 'failed';
            toolCall.error = message;
            toolCall.completedAt = new Date().toISOString();

            functionResponses.push({
              functionResponse: {
                name: fc.name,
                response: { result: `Error: ${message}` },
              },
            });
          }
        }

        // Add function responses to conversation
        conversationParts.push({
          role: 'function',
          parts: functionResponses,
        });

        step.result = step.toolCalls
          .map((tc) => `[${tc.name}] ${tc.status === 'completed' ? tc.output.slice(0, 500) : tc.error}`)
          .join('\n\n');

        run.steps.push(step);

        // Save after each step
        await this.saveRun(run);

        onEvent({
          type: 'step_complete',
          stepIndex,
          content: step.result,
        });

        // Small delay between steps
        await this.sleep(500);
      }

      // Max steps reached
      run.finalAnswer = 'I\'ve reached the maximum number of reasoning steps. Here\'s what I found so far:\n\n' +
        run.steps
          .map((s, i) => `**Step ${i + 1}:** ${s.thought}\n\nTool results:\n${s.result || 'None'}`)
          .join('\n\n---\n\n');

      run.status = 'completed';
      run.completedAt = new Date().toISOString();

      await this.saveRun(run);

      onEvent({
        type: 'final_answer',
        content: run.finalAnswer,
      });
      onEvent({
        type: 'run_complete',
        run: { ...run },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      run.finalAnswer = `Error: ${message}`;

      await this.saveRun(run);

      onEvent({
        type: 'error',
        error: message,
      });
      onEvent({
        type: 'run_complete',
        run: { ...run },
      });
    }

    return run;
  }

  async getRun(id: string): Promise<ToolAgentRun | null> {
    if (!this.db) return null;
    try {
      const row = await this.db.prepare(
        'SELECT * FROM tool_agent_runs WHERE id = ?'
      ).bind(id).first<{
        id: string;
        query: string;
        steps: string;
        final_answer: string;
        status: string;
        total_tool_calls: number;
        created_at: string;
        completed_at: string | null;
      }>();

      if (!row) return null;

      return {
        id: row.id,
        query: row.query,
        steps: JSON.parse(row.steps),
        finalAnswer: row.final_answer,
        status: row.status as ToolAgentRun['status'],
        totalToolCalls: row.total_tool_calls,
        createdAt: row.created_at,
        completedAt: row.completed_at || undefined,
      };
    } catch (err) {
      console.error('[ToolAgent] Failed to get run:', err);
      return null;
    }
  }

  async getRecentRuns(limit = 20): Promise<ToolAgentRun[]> {
    if (!this.db) return [];
    try {
      const { results } = await this.db.prepare(
        'SELECT * FROM tool_agent_runs ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all<{
        id: string;
        query: string;
        steps: string;
        final_answer: string;
        status: string;
        total_tool_calls: number;
        created_at: string;
        completed_at: string | null;
      }>();

      return results.map((row) => ({
        id: row.id,
        query: row.query,
        steps: JSON.parse(row.steps),
        finalAnswer: row.final_answer,
        status: row.status as ToolAgentRun['status'],
        totalToolCalls: row.total_tool_calls,
        createdAt: row.created_at,
        completedAt: row.completed_at || undefined,
      }));
    } catch (err) {
      console.error('[ToolAgent] Failed to get runs:', err);
      return [];
    }
  }
}
