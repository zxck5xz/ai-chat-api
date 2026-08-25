import { BaseAgent, type AgentConfig } from './base-agent';

export interface CodeResult {
  code: string;
  language: 'tsx' | 'html' | 'css';
  files: { name: string; content: string }[];
}

export class CoderAgent extends BaseAgent {
  readonly type = 'coder';

  readonly systemPrompt = `You are a Coder Agent in a multi-agent UI development workflow.

Your job is to generate production-quality React/TypeScript code based on a design specification.

OUTPUT FORMAT:
Return ONLY the code inside a code block. No explanations, no JSON wrapper.

Example:
\`\`\`tsx
// Button.tsx
import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
}

export function Button({ children, onClick }: ButtonProps) {
  return (
    <button onClick={onClick} className="px-4 py-2 bg-blue-600 text-white rounded">
      {children}
    </button>
  );
}
\`\`\`

Rules:
- Use React + TypeScript + Tailwind CSS
- Use modern React patterns (hooks, functional components)
- Include proper TypeScript types
- Use semantic HTML elements
- Include aria labels for accessibility
- Follow the design specification exactly
- Make components responsive with Tailwind
- Use clean, well-structured code
- Output ONLY the code block, nothing else`;

  async code(taskDescription: string, designSpec: string, context?: string): Promise<{ success: boolean; result?: CodeResult; error?: string }> {
    const input = `Generate code for this task with the following design specification:

Task: ${taskDescription}

Design Specification:
${designSpec}

Return ONLY the code in a code block, no JSON.`;

    const response = await this.run(input, context);

    if (!response.success) {
      return { success: false, error: response.error };
    }

    try {
      const result = this.parseCodeResponse(response.output);
      return { success: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private parseCodeResponse(output: string): CodeResult {
    // Extract code from markdown code block
    const codeBlockMatch = output.match(/```(?:tsx|jsx|typescript|ts|js|html|css)?\s*\n([\s\S]*?)```/);
    
    if (codeBlockMatch) {
      const code = codeBlockMatch[1].trim();
      return {
        code,
        language: this.detectLanguage(output),
        files: [{
          name: this.extractFileName(output) || 'Component.tsx',
          content: code
        }]
      };
    }

    // If no code block, try to extract code directly
    const code = output.trim();
    if (code.length > 0) {
      return {
        code,
        language: this.detectLanguage(output),
        files: [{
          name: this.extractFileName(output) || 'Component.tsx',
          content: code
        }]
      };
    }

    throw new Error('No code found in response');
  }

  private detectLanguage(output: string): 'tsx' | 'html' | 'css' {
    if (output.includes('```tsx') || output.includes('```jsx') || output.includes('```typescript')) {
      return 'tsx';
    }
    if (output.includes('```css')) {
      return 'css';
    }
    if (output.includes('```html')) {
      return 'html';
    }
    return 'tsx';
  }

  private extractFileName(output: string): string | null {
    // Try to extract filename from comment like // Button.tsx
    const fileNameMatch = output.match(/\/\/\s*([A-Za-z]+\.(?:tsx|jsx|ts|js|html|css))/);
    if (fileNameMatch) {
      return fileNameMatch[1];
    }
    
    // Try to extract from import statement
    const importMatch = output.match(/import\s+.*?\s+from\s+['"]\.\/(.+?)['"]/);
    if (importMatch) {
      return importMatch[1];
    }
    
    return null;
  }
}
