import { describe, it, expect } from 'vitest';
import { toolRegistry, getToolByName, getGeminiTools } from './tools';

describe('toolRegistry', () => {
  it('has 4 tools registered', () => {
    expect(toolRegistry).toHaveLength(4);
  });

  it('has search_web tool', () => {
    const tool = getToolByName('search_web');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('search_web');
    expect(tool?.description).toContain('Search the web');
  });

  it('has http_request tool', () => {
    const tool = getToolByName('http_request');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('http_request');
  });

  it('has calculate tool', () => {
    const tool = getToolByName('calculate');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('calculate');
  });

  it('has get_current_time tool', () => {
    const tool = getToolByName('get_current_time');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('get_current_time');
  });

  it('returns undefined for unknown tool', () => {
    const tool = getToolByName('unknown_tool');
    expect(tool).toBeUndefined();
  });
});

describe('getGeminiTools', () => {
  it('returns tools in Gemini function declaration format', () => {
    const tools = getGeminiTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations).toHaveLength(4);

    const names = tools[0].functionDeclarations.map((t) => t.name);
    expect(names).toContain('search_web');
    expect(names).toContain('http_request');
    expect(names).toContain('calculate');
    expect(names).toContain('get_current_time');
  });
});

describe('calculate tool', () => {
  it('evaluates basic arithmetic', async () => {
    const tool = getToolByName('calculate');
    expect(tool).toBeDefined();

    const result = await tool!.execute({ expression: '2 + 3' });
    expect(result).toBe('5');
  });

  it('evaluates complex expressions', async () => {
    const tool = getToolByName('calculate');
    const result = await tool!.execute({ expression: '(10 + 5) * 2' });
    expect(result).toBe('30');
  });

  it('handles division', async () => {
    const tool = getToolByName('calculate');
    const result = await tool!.execute({ expression: '10 / 3' });
    expect(result).toBe('3.3333333333333335');
  });
});

describe('get_current_time tool', () => {
  it('returns ISO date string', async () => {
    const tool = getToolByName('get_current_time');
    expect(tool).toBeDefined();

    const result = await tool!.execute({});
    const date = new Date(result);
    expect(date.toString()).not.toBe('Invalid Date');
  });
});
