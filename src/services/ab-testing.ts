/**
 * A/B Testing Framework for RAG
 * Test different prompts, chunking strategies, and configurations
 */

export interface ABTestConfig {
  id: string;
  name: string;
  description: string;
  variants: ABVariant[];
  trafficSplit: number[];  // Percentage of traffic for each variant
  status: 'draft' | 'running' | 'paused' | 'completed';
  createdAt: string;
  endedAt?: string;
}

export interface ABVariant {
  id: string;
  name: string;
  config: VariantConfig;
}

export interface VariantConfig {
  promptTemplate?: string;
  chunkingStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  searchMethod?: 'vector' | 'bm25' | 'hybrid';
  hybridConfig?: {
    vectorWeight: number;
    bm25Weight: number;
    fusionMethod: string;
  };
  topK?: number;
  temperature?: number;
  model?: string;
}

export interface ABTestResult {
  testId: string;
  variantId: string;
  query: string;
  latencyMs: number;
  resultCount: number;
  scores?: {
    relevance?: number;
    faithfulness?: number;
    userRating?: 'positive' | 'negative' | null;
  };
  timestamp: string;
}

export interface ABTestSummary {
  testId: string;
  variantSummaries: VariantSummary[];
  winner?: string;
  confidence?: number;
}

export interface VariantSummary {
  variantId: string;
  variantName: string;
  totalQueries: number;
  avgLatencyMs: number;
  avgRelevance: number;
  avgFaithfulness: number;
  positiveRatio: number;
}

/**
 * In-memory A/B test store (replace with D1 in production)
 */
const abTests = new Map<string, ABTestConfig>();
const abResults = new Map<string, ABTestResult[]>();

/**
 * Create a new A/B test
 */
export function createABTest(
  config: Omit<ABTestConfig, 'id' | 'createdAt' | 'status'>
): ABTestConfig {
  const test: ABTestConfig = {
    ...config,
    id: crypto.randomUUID(),
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  
  abTests.set(test.id, test);
  return test;
}

/**
 * Start an A/B test
 */
export function startABTest(testId: string): ABTestConfig | null {
  const test = abTests.get(testId);
  if (!test) return null;
  
  test.status = 'running';
  abTests.set(testId, test);
  return test;
}

/**
 * Pause an A/B test
 */
export function pauseABTest(testId: string): ABTestConfig | null {
  const test = abTests.get(testId);
  if (!test) return null;
  
  test.status = 'paused';
  abTests.set(testId, test);
  return test;
}

/**
 * Complete an A/B test
 */
export function completeABTest(testId: string): ABTestConfig | null {
  const test = abTests.get(testId);
  if (!test) return null;
  
  test.status = 'completed';
  test.endedAt = new Date().toISOString();
  abTests.set(testId, test);
  return test;
}

/**
 * Select a variant based on traffic split
 */
export function selectVariant(test: ABTestConfig): ABVariant {
  const random = Math.random() * 100;
  let cumulative = 0;
  
  for (let i = 0; i < test.variants.length; i++) {
    cumulative += test.trafficSplit[i] || 0;
    if (random <= cumulative) {
      return test.variants[i];
    }
  }
  
  // Default to first variant
  return test.variants[0];
}

/**
 * Record an A/B test result
 */
export function recordABTestResult(result: Omit<ABTestResult, 'timestamp'>): void {
  const fullResult: ABTestResult = {
    ...result,
    timestamp: new Date().toISOString(),
  };
  
  const results = abResults.get(result.testId) || [];
  results.push(fullResult);
  abResults.set(result.testId, results);
}

/**
 * Get A/B test summary
 */
export function getABTestSummary(testId: string): ABTestSummary | null {
  const test = abTests.get(testId);
  if (!test) return null;
  
  const results = abResults.get(testId) || [];
  
  const variantSummaries: VariantSummary[] = test.variants.map((variant) => {
    const variantResults = results.filter((r) => r.variantId === variant.id);
    
    if (variantResults.length === 0) {
      return {
        variantId: variant.id,
        variantName: variant.name,
        totalQueries: 0,
        avgLatencyMs: 0,
        avgRelevance: 0,
        avgFaithfulness: 0,
        positiveRatio: 0,
      };
    }
    
    const avgLatency =
      variantResults.reduce((sum, r) => sum + r.latencyMs, 0) /
      variantResults.length;
    
    const relevanceScores = variantResults
      .filter((r) => r.scores?.relevance !== undefined)
      .map((r) => r.scores!.relevance!);
    
    const faithfulnessScores = variantResults
      .filter((r) => r.scores?.faithfulness !== undefined)
      .map((r) => r.scores!.faithfulness!);
    
    const positiveRatings = variantResults.filter(
      (r) => r.scores?.userRating === 'positive'
    ).length;
    
    const totalRatings = variantResults.filter(
      (r) => r.scores?.userRating !== null && r.scores?.userRating !== undefined
    ).length;
    
    return {
      variantId: variant.id,
      variantName: variant.name,
      totalQueries: variantResults.length,
      avgLatencyMs: avgLatency,
      avgRelevance:
        relevanceScores.length > 0
          ? relevanceScores.reduce((a, b) => a + b, 0) / relevanceScores.length
          : 0,
      avgFaithfulness:
        faithfulnessScores.length > 0
          ? faithfulnessScores.reduce((a, b) => a + b, 0) /
            faithfulnessScores.length
          : 0,
      positiveRatio: totalRatings > 0 ? positiveRatings / totalRatings : 0,
    };
  });
  
  // Determine winner (variant with highest positive ratio)
  const sortedByPositive = [...variantSummaries]
    .filter((v) => v.totalQueries >= 10) // Need minimum samples
    .sort((a, b) => b.positiveRatio - a.positiveRatio);
  
  return {
    testId,
    variantSummaries,
    winner: sortedByPositive[0]?.variantId,
    confidence: sortedByPositive[0]
      ? calculateConfidence(sortedByPositive[0], sortedByPositive[1])
      : undefined,
  };
}

/**
 * Simple confidence calculation
 */
function calculateConfidence(
  winner: VariantSummary,
  runnerUp?: VariantSummary
): number {
  if (!runnerUp || runnerUp.totalQueries === 0) return 0;
  
  const winnerRate = winner.positiveRatio;
  const runnerUpRate = runnerUp.positiveRatio;
  
  // Simple confidence based on difference and sample size
  const diff = winnerRate - runnerUpRate;
  const minSamples = Math.min(winner.totalQueries, runnerUp.totalQueries);
  
  // More samples and larger difference = higher confidence
  const sampleConfidence = Math.min(minSamples / 30, 1); // Max at 30 samples
  const diffConfidence = Math.min(Math.abs(diff) / 0.3, 1); // Max at 30% difference
  
  return sampleConfidence * diffConfidence;
}

/**
 * Get all A/B tests
 */
export function getAllABTests(): ABTestConfig[] {
  return Array.from(abTests.values());
}

/**
 * Get A/B test by ID
 */
export function getABTest(testId: string): ABTestConfig | null {
  return abTests.get(testId) || null;
}

/**
 * Delete an A/B test
 */
export function deleteABTest(testId: string): boolean {
  abTests.delete(testId);
  abResults.delete(testId);
  return true;
}
