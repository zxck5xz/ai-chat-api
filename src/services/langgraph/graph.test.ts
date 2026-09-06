import { describe, it, expect } from 'vitest';
import { StateGraph } from './graph';
import { type StateSchema } from './state';
import { ObservabilityTracer } from './observability';
import { MemoryCheckpointer } from './checkpoint';

const testSchema = {
  value: { default: 0 },
  messages: { default: [] as string[] },
  status: { default: 'pending' },
} satisfies StateSchema;

describe('StateGraph', () => {
  it('should execute a simple linear graph', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('start', async () => ({ value: 1, messages: ['started'] }))
      .addNode('end', async (state) => ({ messages: [...state.messages, `end at ${state.value}`], status: 'done' }))
      .addEdge('start', 'end')
      .setEntryPoint('start')
      .setFinishPoint('end');

    const compiled = await graph.compile();
    const result = await compiled({});
    expect(result.value).toBe(1);
    expect(result.messages).toEqual(['started', 'end at 1']);
    expect(result.status).toBe('done');
  });

  it('should handle conditional edges', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('router', async (state) => ({ status: state.value > 5 ? 'high' : 'low' }))
      .addNode('high', async () => ({ messages: ['high path'] }))
      .addNode('low', async () => ({ messages: ['low path'] }))
      .addConditionalEdge('router', (state: any) => state.status)
      .addEdge('high', '__end__')
      .addEdge('low', '__end__')
      .setEntryPoint('router')
      .setFinishPoint('__end__');

    const compiled = await graph.compile();
    expect((await compiled({ value: 10 })).messages).toEqual(['high path']);
    expect((await compiled({ value: 3 })).messages).toEqual(['low path']);
  });

  it('should merge state updates correctly', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('a', async () => ({ value: 5, messages: ['a'] }))
      .addNode('b', async (state) => ({ value: state.value + 3, messages: [...state.messages, 'b'] }))
      .addEdge('a', 'b')
      .setEntryPoint('a')
      .setFinishPoint('b');

    const compiled = await graph.compile();
    const result = await compiled({});
    expect(result.value).toBe(8);
    expect(result.messages).toEqual(['a', 'b']);
  });

  it('should retry failed nodes', async () => {
    let attempts = 0;
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('flaky', async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return { value: 1, status: 'done' };
      }, { maxAttempts: 3, backoffMs: 10 })
      .setEntryPoint('flaky')
      .setFinishPoint('flaky');

    const compiled = await graph.compile();
    const result = await compiled({});
    expect(attempts).toBe(3);
    expect(result.status).toBe('done');
  });

  it('should respect max iterations', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema, maxIterations: 3 });
    let count = 0;
    graph
      .addNode('loop', async () => { count++; return { value: count }; })
      .addEdge('loop', 'loop')
      .setEntryPoint('loop');

    const compiled = await graph.compile();
    const result = await compiled({});
    expect(result.value).toBe(3);
  });

  it('should trace nodes', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('step1', async () => ({ value: 1 }))
      .addNode('step2', async () => ({ value: 2 }))
      .addEdge('step1', 'step2')
      .setEntryPoint('step1')
      .setFinishPoint('step2');

    const tracer = new ObservabilityTracer('test', 't1');
    const compiled = await graph.compile({ tracer });
    await compiled({});

    expect(tracer.getTraces()).toHaveLength(2);
    expect(tracer.getTraces()[0].nodeId).toBe('step1');
    expect(tracer.getTraces()[1].nodeId).toBe('step2');
  });

  it('should save and load checkpoints', async () => {
    const checkpointer = new MemoryCheckpointer();
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('step1', async () => ({ value: 10 }))
      .addNode('step2', async (state) => ({ value: state.value + 5 }))
      .addEdge('step1', 'step2')
      .setEntryPoint('step1')
      .setFinishPoint('step2');

    const compiled = await graph.compile({ checkpointer, threadId: 't1' });
    await compiled({});
    const checkpoint = await checkpointer.load('t1');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.state.value).toBe(15);
  });

  it('should build trace summary', async () => {
    const graph = new StateGraph({ name: 'test', stateSchema: testSchema });
    graph
      .addNode('a', async () => ({ value: 1 }))
      .setEntryPoint('a')
      .setFinishPoint('a');

    const tracer = new ObservabilityTracer('test', 't1');
    const compiled = await graph.compile({ tracer });
    await compiled({});

    const trace = tracer.buildTrace('completed', { value: 1 });
    expect(trace.graphName).toBe('test');
    expect(trace.status).toBe('completed');
    expect(trace.nodes).toHaveLength(1);
  });
});
