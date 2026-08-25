import { BaseAgent, type AgentConfig } from './base-agent';

export interface DesignSpec {
  layout: string;
  colorPalette: string[];
  typography: string;
  components: string[];
  responsive: string;
}

export class DesignerAgent extends BaseAgent {
  readonly type = 'designer';

  readonly systemPrompt = `You are a Designer Agent in a multi-agent UI development workflow.

Your job is to create a detailed design specification based on a task description.

Output a JSON object with this exact structure:
{
  "layout": "Description of the page layout (e.g., 'Hero section with full-width image, 3-column grid below, sticky navbar')",
  "colorPalette": ["#hex1", "#hex2", "#hex3", "#hex4", "#hex5"],
  "typography": "Font choices and sizes (e.g., 'Inter for body, 16px base; Poppins for headings, 32px h1')",
  "components": ["Component1: description", "Component2: description"],
  "responsive": "Mobile-first responsive strategy (e.g., 'Stack columns on mobile, 2-col on tablet, 3-col on desktop')"
}

Rules:
- Use modern, clean design principles
- Choose accessible color combinations (WCAG AA contrast)
- Be specific about spacing, sizing, and visual hierarchy
- Include 5-8 components
- Do NOT include any text outside the JSON object`;

  async design(taskDescription: string, context?: string): Promise<{ success: boolean; result?: DesignSpec; error?: string }> {
    const input = `Create a design specification for: ${taskDescription}`;
    const response = await this.run(input, context);

    if (!response.success) {
      return { success: false, error: response.error };
    }

    try {
      const result = JSON.parse(response.output) as DesignSpec;
      return { success: true, result };
    } catch {
      const match = response.output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const result = JSON.parse(match[0]) as DesignSpec;
          return { success: true, result };
        } catch {
          return { success: false, error: 'Failed to parse designer response' };
        }
      }
      return { success: false, error: 'No JSON in designer response' };
    }
  }
}
