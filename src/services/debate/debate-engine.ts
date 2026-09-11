// Project 17: Multi-Agent Debate & Verifier — Debate Engine
// Orchestrates the full debate flow: debaters → judge → fact-checker → consensus

import type {
  DebateFormat,
  DebateRun,
  DebateStatus,
  ArgumentPosition,
  DebaterResult,
  JudgeVerdict,
  FactCheckResult,
  ConsensusResult,
  DebateEvent,
} from '../../types/debate';
import { DebaterAgent } from './debater-agent';
import { JudgeAgent } from './judge-agent';
import { FactCheckerAgent } from './fact-checker-agent';
import { ConsensusBuilder } from './consensus-builder';
import { DebateStore } from './persistence';

const POSITIONS: ArgumentPosition[] = ['for', 'against', 'nuanced'];

export class DebateEngine {
  private apiKey: string;
  private store: DebateStore;

  constructor(apiKey: string, store: DebateStore) {
    this.apiKey = apiKey;
    this.store = store;
  }

  async run(
    question: string,
    format: DebateFormat = 'free_form',
    onEvent?: (event: DebateEvent) => void
  ): Promise<DebateRun> {
    const startTime = Date.now();
    const debateId = crypto.randomUUID();

    const run: DebateRun = {
      id: debateId,
      question,
      format,
      status: 'debating',
      debaters: [],
      judge_verdict: null,
      fact_check: null,
      consensus: null,
      total_rounds: 0,
      total_claims: 0,
      accuracy_rate: 0,
      duration_ms: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    await this.store.saveRun(run);

    try {
      // Phase 1: Debate
      const debaters = await this.runDebate(question, format, onEvent, debateId);
      run.debaters = debaters;
      run.total_rounds = debaters.reduce((sum, d) => sum + d.arguments.length, 0);

      // Phase 2: Judge
      run.status = 'judging';
      onEvent?.({ type: 'judge_start', data: {} });

      const judgeAgent = new JudgeAgent(this.apiKey);
      const argsByPosition: Record<ArgumentPosition, string[]> = {
        for: debaters.find(d => d.position === 'for')?.arguments.map(a => a.content) || [],
        against: debaters.find(d => d.position === 'against')?.arguments.map(a => a.content) || [],
        nuanced: debaters.find(d => d.position === 'nuanced')?.arguments.map(a => a.content) || [],
      };
      run.judge_verdict = await judgeAgent.judge(question, argsByPosition);
      onEvent?.({ type: 'verdict', data: { verdict: run.judge_verdict } });

      // Phase 3: Fact-check
      run.status = 'fact_checking';
      onEvent?.({ type: 'fact_check_start', data: {} });

      const factChecker = new FactCheckerAgent(this.apiKey);
      run.fact_check = await factChecker.factCheck(question, argsByPosition);
      run.total_claims = run.fact_check.total_claims;
      run.accuracy_rate = run.fact_check.accuracy_rate;
      onEvent?.({ type: 'fact_check', data: { factCheck: run.fact_check } });

      // Phase 4: Consensus
      run.status = 'consensus';
      onEvent?.({ type: 'consensus_start', data: {} });

      const consensusBuilder = new ConsensusBuilder(this.apiKey);
      run.consensus = await consensusBuilder.build(
        question,
        argsByPosition,
        run.judge_verdict,
        run.fact_check.accuracy_rate
      );
      onEvent?.({ type: 'consensus', data: { consensus: run.consensus } });

      // Complete
      run.status = 'completed';
      run.duration_ms = Date.now() - startTime;
      run.completed_at = new Date().toISOString();

      await this.store.saveRun(run);
      onEvent?.({ type: 'complete', data: { run } });

      return run;
    } catch (error) {
      run.status = 'failed';
      run.duration_ms = Date.now() - startTime;
      await this.store.saveRun(run);
      onEvent?.({ type: 'error', data: { error: error instanceof Error ? error.message : 'Unknown error' } });
      throw error;
    }
  }

  private async runDebate(
    question: string,
    format: DebateFormat,
    onEvent: ((event: DebateEvent) => void) | undefined,
    debateId: string
  ): Promise<DebaterResult[]> {
    const debaters = new DebaterAgent(this.apiKey);
    const results: DebaterResult[] = [];
    const rounds: ('opening' | 'rebuttal' | 'closing')[] =
      format === 'free_form' ? ['opening', 'closing'] : ['opening', 'rebuttal', 'closing'];

    const allArguments: Record<ArgumentPosition, string[]> = {
      for: [],
      against: [],
      nuanced: [],
    };

    for (const position of POSITIONS) {
      const positionArgs = [];
      for (const round of rounds) {
        onEvent?.({ type: 'debater_start', data: { position, round } });

        const arg = await debaters.argue(question, position, round, {
          previousArguments: round !== 'opening' ? allArguments[position] : undefined,
        });

        positionArgs.push(arg);
        allArguments[position].push(arg.content);
        onEvent?.({ type: 'argument', data: { argument: arg } });
      }

      const overall_score = positionArgs.reduce((sum, a) => sum + a.strength_score, 0) / positionArgs.length;
      results.push({
        agent_id: `debater-${position}`,
        position,
        arguments: positionArgs,
        overall_score,
      });
    }

    return results;
  }

  async getRun(id: string): Promise<DebateRun | null> {
    return this.store.getRun(id);
  }

  async getRuns(limit = 20, offset = 0): Promise<{ runs: DebateRun[]; total: number }> {
    return this.store.getRuns(limit, offset);
  }

  async getMetrics() {
    return this.store.getMetrics();
  }
}
