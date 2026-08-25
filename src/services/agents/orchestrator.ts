import { PlannerAgent, type PlannerTask } from './planner-agent';
import { DesignerAgent } from './designer-agent';
import { CoderAgent } from './coder-agent';
import { ReviewerAgent } from './reviewer-agent';
import type { AgentTask, WorkflowRun, WorkflowEvent } from '../../types/agents';

export interface OrchestratorConfig {
  apiKey: string;
  model?: string;
}

export class Orchestrator {
  private planner: PlannerAgent;
  private designer: DesignerAgent;
  private coder: CoderAgent;
  private reviewer: ReviewerAgent;
  private model: string;

  constructor(config: OrchestratorConfig) {
    this.model = config.model || 'gemini-3.6-flash';
    const agentConfig = { apiKey: config.apiKey, model: this.model };
    this.planner = new PlannerAgent(agentConfig);
    this.designer = new DesignerAgent(agentConfig);
    this.coder = new CoderAgent(agentConfig);
    this.reviewer = new ReviewerAgent(agentConfig);
  }

  async runWorkflow(
    userInput: string,
    onEvent: (event: WorkflowEvent) => void
  ): Promise<WorkflowRun> {
    const workflowId = crypto.randomUUID();
    const workflow: WorkflowRun = {
      id: workflowId,
      requestId: crypto.randomUUID(),
      userInput,
      tasks: [],
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    try {
      // Step 1: Plan
      onEvent({ type: 'task_start', agent: 'planner' });
      const planResult = await this.planner.plan(userInput);

      if (!planResult.success || !planResult.result) {
        workflow.status = 'failed';
        workflow.completedAt = new Date().toISOString();
        onEvent({ type: 'task_error', agent: 'planner', error: planResult.error });
        return workflow;
      }

      const { tasks: plannedTasks, summary } = planResult.result;
      onEvent({
        type: 'task_complete',
        agent: 'planner',
        content: summary,
      });

      // Delay between agents to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Step 2: Execute tasks in order
      for (const plannedTask of plannedTasks) {
        const task: AgentTask = {
          id: plannedTask.id,
          agent: plannedTask.agent,
          status: 'running',
          input: plannedTask.description,
          output: '',
          startedAt: new Date().toISOString(),
        };
        workflow.tasks.push(task);

        onEvent({ type: 'task_start', taskId: task.id, agent: task.agent });

        let result: { success: boolean; output?: string; error?: string };

        switch (task.agent) {
          case 'designer': {
            const context = this.getCompletedOutputs(workflow.tasks, plannedTask.dependsOn);
            const designResult = await this.designer.design(task.input, context);
            if (designResult.success && designResult.result) {
              result = { success: true, output: JSON.stringify(designResult.result, null, 2) };
              task.metadata = designResult.result;
            } else {
              result = { success: false, error: designResult.error };
            }
            break;
          }

          case 'coder': {
            const context = this.getCompletedOutputs(workflow.tasks, plannedTask.dependsOn);
            const codeResult = await this.coder.code(task.input, context);
            if (codeResult.success && codeResult.result) {
              result = { success: true, output: JSON.stringify(codeResult.result, null, 2) };
              task.metadata = codeResult.result;
            } else {
              result = { success: false, error: codeResult.error };
            }
            break;
          }

          case 'reviewer': {
            const context = this.getCompletedOutputs(workflow.tasks, plannedTask.dependsOn);
            const codeOutput = this.getCodeOutput(workflow.tasks, plannedTask.dependsOn);
            const reviewResult = await this.reviewer.review(codeOutput || task.input, context);
            if (reviewResult.success && reviewResult.result) {
              result = { success: true, output: JSON.stringify(reviewResult.result, null, 2) };
              task.metadata = reviewResult.result;
            } else {
              result = { success: false, error: reviewResult.error };
            }
            break;
          }

          default:
            result = { success: false, error: `Unknown agent: ${task.agent}` };
        }

        task.completedAt = new Date().toISOString();

        if (result.success) {
          task.status = 'completed';
          task.output = result.output || '';
          onEvent({ type: 'task_complete', taskId: task.id, agent: task.agent, content: result.output });
        } else {
          task.status = 'failed';
          task.error = result.error;
          onEvent({ type: 'task_error', taskId: task.id, agent: task.agent, error: result.error });
        }

        // Delay between tasks to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      workflow.status = 'completed';
      workflow.completedAt = new Date().toISOString();
      onEvent({ type: 'workflow_complete' });
    } catch (err) {
      workflow.status = 'failed';
      workflow.completedAt = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'task_error', error: message });
    }

    return workflow;
  }

  private getCompletedOutputs(tasks: AgentTask[], dependsOn?: string[]): string {
    if (!dependsOn || dependsOn.length === 0) return '';

    return tasks
      .filter((t) => dependsOn.includes(t.id) && t.status === 'completed')
      .map((t) => `[${t.agent} output]: ${t.output}`)
      .join('\n\n');
  }

  private getCodeOutput(tasks: AgentTask[], dependsOn?: string[]): string | null {
    if (!dependsOn) return null;

    for (const taskId of dependsOn) {
      const task = tasks.find((t) => t.id === taskId && t.agent === 'coder' && t.status === 'completed');
      if (task) return task.output;
    }

    return null;
  }
}
