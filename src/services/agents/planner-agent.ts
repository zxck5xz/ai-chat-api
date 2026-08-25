import { BaseAgent, type AgentConfig } from './base-agent';

export interface PlannerTask {
  id: string;
  description: string;
  agent: 'designer' | 'coder' | 'reviewer';
  dependsOn?: string[];
}

export interface PlannerResult {
  tasks: PlannerTask[];
  summary: string;
}

export class PlannerAgent extends BaseAgent {
  readonly type = 'planner';

  readonly systemPrompt = `You are a Planner Agent in a multi-agent UI development workflow.

Your job is to analyze a user request and break it down into concrete tasks for other agents.

Available agents:
- designer: Proposes layout, colors, typography, visual design
- coder: Generates React/HTML/CSS code
- reviewer: Checks accessibility, performance, code quality

Output a JSON object with this exact structure:
{
  "summary": "Brief summary of what will be built",
  "tasks": [
    {
      "id": "task-1",
      "description": "What this task should accomplish",
      "agent": "designer|coder|reviewer",
      "dependsOn": ["task-id"] (optional, array of task IDs this depends on)
    }
  ]
}

Rules:
- Always start with a designer task for visual planning
- Coder tasks should depend on designer tasks
- Reviewer tasks should depend on coder tasks
- Keep tasks focused and atomic
- 3-6 tasks is ideal
- Do NOT include any text outside the JSON object`;

  async plan(userInput: string): Promise<{ success: boolean; result?: PlannerResult; error?: string }> {
    const response = await this.run(userInput);

    if (!response.success) {
      return { success: false, error: response.error };
    }

    try {
      const result = JSON.parse(response.output) as PlannerResult;
      return { success: true, result };
    } catch {
      // Try to extract JSON from response
      const match = response.output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const result = JSON.parse(match[0]) as PlannerResult;
          return { success: true, result };
        } catch {
          return { success: false, error: 'Failed to parse planner response' };
        }
      }
      return { success: false, error: 'No JSON in planner response' };
    }
  }
}
