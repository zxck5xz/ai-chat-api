/**
 * Retrieval Loop Engine
 * Core orchestrator: retrieve → generate → evaluate → re-retrieve until confident.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { embedText } from '../embedder';
import { searchSimilar } from '../qdrant';
import { rerank, type RerankableDocument } from '../reranker';
import { QueryAnalyzer } from './query-analyzer';
import { AnswerGenerator } from './answer-generator';
import { ConfidenceEvaluator } from './confidence-evaluator';
import type {
  QueryAnalysis,
  RetrievalRound,
  AgenticRAGStep,
  AgenticRAGRun,
  ConfidenceEvaluation,
} from '../../types/agentic-rag';

export interface RetrievalLoopConfig {
  maxRounds: number;
  confidenceThreshold: number;
  topK: number;
  rerankTopN: number;
}

export interface RetrievalLoopResult {
  run: AgenticRAGRun;
  events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }>;
}

const DEFAULT_CONFIG: RetrievalLoopConfig = {
  maxRounds: 3,
  confidenceThreshold: 0.7,
  topK: 10,
  rerankTopN: 5,
};

export class RetrievalLoop {
  private qdrant: QdrantClient;
  private collectionName: string;
  private geminiApiKey: string;
  private cohereApiKey?: string;
  private config: RetrievalLoopConfig;
  private queryAnalyzer: QueryAnalyzer;
  private answerGenerator: AnswerGenerator;
  private confidenceEvaluator: ConfidenceEvaluator;

  constructor(
    qdrant: QdrantClient,
    collectionName: string,
    geminiApiKey: string,
    cohereApiKey?: string,
    config: Partial<RetrievalLoopConfig> = {}
  ) {
    this.qdrant = qdrant;
    this.collectionName = collectionName;
    this.geminiApiKey = geminiApiKey;
    this.cohereApiKey = cohereApiKey;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.queryAnalyzer = new QueryAnalyzer(geminiApiKey);
    this.answerGenerator = new AnswerGenerator(geminiApiKey);
    this.confidenceEvaluator = new ConfidenceEvaluator(geminiApiKey, this.config.confidenceThreshold);
  }

  /**
   * Run the full agentic RAG pipeline
   */
  async run(query: string): Promise<RetrievalLoopResult> {
    const runId = crypto.randomUUID();
    const startTime = Date.now();
    const events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }> = [];
    const steps: AgenticRAGStep[] = [];
    const rounds: RetrievalRound[] = [];
    let previousAttempts: Array<{ query: string; answer: string; round: number }> = [];
    let finalAnswer = '';
    let confidence: ConfidenceEvaluation = {
      score: 0,
      reasoning: '',
      hasHallucination: false,
      citationCoverage: 0,
      contradictionsFound: 0,
      needsRegeneration: false,
      needsMoreRetrieval: false,
    };

    // Step 1: Analyze query
    const analysisStart = Date.now();
    const analysis = await this.queryAnalyzer.analyze(query);
    const analysisStep: AgenticRAGStep = {
      stepNumber: steps.length + 1,
      type: 'classify',
      query,
      input: query,
      output: JSON.stringify(analysis),
      latencyMs: Date.now() - analysisStart,
      metadata: { intent: analysis.intent, complexity: analysis.complexity },
    };
    steps.push(analysisStep);
    events.push({
      type: 'analysis',
      data: { analysis },
      timestamp: new Date().toISOString(),
    });

    // If retrieval not needed, generate directly (no sources)
    if (analysis.needsRetrieval === 'skip') {
      const genStart = Date.now();
      const generated = await this.answerGenerator.generate(query, []);
      finalAnswer = generated.answer;
      confidence = {
        score: 0.5,
        reasoning: 'Retrieval skipped — answer generated from model knowledge',
        hasHallucination: false,
        citationCoverage: 0,
        contradictionsFound: 0,
        needsRegeneration: false,
        needsMoreRetrieval: false,
      };

      steps.push({
        stepNumber: steps.length + 1,
        type: 'generate',
        query,
        input: 'No sources (skip)',
        output: finalAnswer,
        latencyMs: Date.now() - genStart,
        metadata: { skipped: true },
      });

      return {
        run: {
          id: runId,
          query,
          analysis,
          rounds: [],
          steps,
          finalAnswer,
          confidence,
          totalRounds: 0,
          totalLatencyMs: Date.now() - startTime,
          status: 'completed',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        events,
      };
    }

    // Retrieval loop
    let currentQuery = query;
    let roundNumber = 0;
    const maxRounds = Math.min(analysis.maxRetrievalRounds, this.config.maxRounds);
    let allChunks: Array<{ content: string; documentTitle: string; documentUrl: string; score: number }> = [];

    while (roundNumber < maxRounds) {
      roundNumber++;

      // Step 2: Retrieve
      const retrievalStart = Date.now();
      const retrieved = await this.retrieve(currentQuery, analysis.suggestedTopK || this.config.topK);
      const retrievalLatency = Date.now() - retrievalStart;

      const roundChunks = retrieved.map((r) => ({
        content: r.content,
        documentTitle: r.documentTitle,
        documentUrl: r.documentUrl,
        score: r.score,
      }));

      // Track round metrics
      const scores = retrieved.map((r) => r.score);
      const round: RetrievalRound = {
        roundNumber,
        query: currentQuery,
        strategy: roundNumber === 1 ? 'initial' : 're-retrieve',
        chunksRetrieved: retrieved.length,
        avgRelevanceScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
        topScore: scores.length > 0 ? Math.max(...scores) : 0,
        latencyMs: retrievalLatency,
      };
      rounds.push(round);

      events.push({
        type: 'retrieval',
        data: { round: roundNumber, chunks: retrieved.length, topScore: round.topScore, query: currentQuery },
        timestamp: new Date().toISOString(),
      });

      steps.push({
        stepNumber: steps.length + 1,
        type: 'retrieve',
        query: currentQuery,
        input: currentQuery,
        output: JSON.stringify({ chunksRetrieved: retrieved.length, topScore: round.topScore }),
        latencyMs: retrievalLatency,
        metadata: { round: roundNumber, strategy: round.strategy },
      });

      if (retrieved.length === 0) {
        // No chunks found — try expanding query
        currentQuery = await this.expandQuery(currentQuery, analysis);
        continue;
      }

      // Merge chunks (deduplicate by content)
      const seen = new Set(allChunks.map((c) => c.content));
      for (const chunk of roundChunks) {
        if (!seen.has(chunk.content)) {
          allChunks.push(chunk);
          seen.add(chunk.content);
        }
      }

      // Step 3: Generate
      const genStart = Date.now();
      const generated = await this.answerGenerator.generate(query, allChunks, previousAttempts);
      finalAnswer = generated.answer;

      steps.push({
        stepNumber: steps.length + 1,
        type: 'generate',
        query,
        input: `${allChunks.length} chunks`,
        output: finalAnswer,
        latencyMs: Date.now() - genStart,
        metadata: { round: roundNumber, sourcesUsed: generated.sourcesUsed },
      });

      // Step 4: Evaluate
      const evalStart = Date.now();
      confidence = await this.confidenceEvaluator.evaluate(query, finalAnswer, allChunks);

      steps.push({
        stepNumber: steps.length + 1,
        type: 'evaluate',
        query,
        input: finalAnswer,
        output: JSON.stringify(confidence),
        latencyMs: Date.now() - evalStart,
        metadata: { round: roundNumber, score: confidence.score },
      });

      events.push({
        type: 'evaluation',
        data: { round: roundNumber, confidence: confidence.score, hasHallucination: confidence.hasHallucination },
        timestamp: new Date().toISOString(),
      });

      // Store attempt for next round context
      previousAttempts.push({ query: currentQuery, answer: finalAnswer, round: roundNumber });

      // Check if confident enough
      if (confidence.score >= this.config.confidenceThreshold) {
        break;
      }

      // Check if we should re-retrieve or correct
      if (confidence.needsMoreRetrieval && roundNumber < maxRounds) {
        currentQuery = await this.expandQuery(query, analysis);
        continue;
      }

      if (confidence.needsRegeneration && roundNumber < maxRounds) {
        // Try with different query expansion
        currentQuery = await this.expandQuery(query, analysis, 'step_back');
        continue;
      }

      // Low confidence but no clear path forward — stop
      break;
    }

    // Synthesize final answer if we have multiple rounds
    if (rounds.length > 1) {
      const synthStart = Date.now();
      const synthesized = await this.answerGenerator.generate(query, allChunks, previousAttempts);
      finalAnswer = synthesized.answer;

      steps.push({
        stepNumber: steps.length + 1,
        type: 'synthesize',
        query,
        input: `${rounds.length} rounds, ${allChunks.length} total chunks`,
        output: finalAnswer,
        latencyMs: Date.now() - synthStart,
        metadata: { totalRounds: rounds.length, totalChunks: allChunks.length },
      });
    }

    events.push({
      type: 'answer',
      data: { answer: finalAnswer.slice(0, 200), confidence: confidence.score, rounds: roundNumber },
      timestamp: new Date().toISOString(),
    });

    return {
      run: {
        id: runId,
        query,
        analysis,
        rounds,
        steps,
        finalAnswer,
        confidence,
        totalRounds: roundNumber,
        totalLatencyMs: Date.now() - startTime,
        status: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      events,
    };
  }

  /**
   * Retrieve and rerank chunks for a query
   */
  private async retrieve(
    query: string,
    topK: number
  ): Promise<Array<{ content: string; documentTitle: string; documentUrl: string; score: number }>> {
    try {
      const embedding = await embedText(this.geminiApiKey, query);
      const results = await searchSimilar(this.qdrant, embedding, topK);

      if (results.length === 0) return [];

      // Rerank with Cohere if available, otherwise use local
      const rerankableDocs: RerankableDocument[] = results.map((r) => ({
        id: r.id,
        content: r.content,
      }));

      const reranked = await rerank(this.cohereApiKey, query, rerankableDocs, {
        topN: Math.min(this.config.rerankTopN, results.length),
      });

      // Map reranked results back to full data
      const resultMap = new Map(results.map((r) => [r.id, r]));

      return reranked.map((r) => {
        const original = resultMap.get(r.id);
        return {
          content: r.content,
          documentTitle: original?.documentTitle || '',
          documentUrl: original?.documentUrl || '',
          score: r.relevanceScore,
        };
      });
    } catch (err) {
      console.error('Retrieval failed:', err);
      return [];
    }
  }

  /**
   * Expand query for re-retrieval using different strategies
   */
  private async expandQuery(
    originalQuery: string,
    analysis: QueryAnalysis,
    strategy?: 'hyde' | 'multi_query' | 'decomposition' | 'step_back'
  ): Promise<string> {
    try {
      const expandStrategy = strategy || this.selectExpandStrategy(analysis);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: this.getExpandPrompt(expandStrategy, originalQuery),
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 256,
              temperature: 0.3,
            },
          }),
        }
      );

      if (!response.ok) return originalQuery;

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const expanded = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      return expanded || originalQuery;
    } catch {
      return originalQuery;
    }
  }

  private selectExpandStrategy(analysis: QueryAnalysis): string {
    if (analysis.retrievalStrategy === 'decompose') return 'decomposition';
    if (analysis.retrievalStrategy === 'step_back') return 'step_back';
    if (analysis.complexity > 0.7) return 'multi_query';
    return 'hyde';
  }

  private getExpandPrompt(strategy: string, query: string): string {
    switch (strategy) {
      case 'hyde':
        return `Generate a hypothetical document paragraph that would perfectly answer this query. Be factual and specific. Return ONLY the paragraph.\n\nQuery: "${query}"`;
      case 'multi_query':
        return `Generate 3 different search queries for this topic using different vocabulary. Return ONLY the queries, one per line.\n\nQuery: "${query}"`;
      case 'decomposition':
        return `Break this query into 2-3 simpler sub-questions. Return ONLY the sub-questions, one per line.\n\nQuery: "${query}"`;
      case 'step_back':
        return `Generate a broader, more general query that captures the underlying concept of this specific question. Return ONLY the broader query.\n\nQuery: "${query}"`;
      default:
        return query;
    }
  }
}
