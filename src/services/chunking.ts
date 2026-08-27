/**
 * Advanced Chunking Strategies
 * Semantic, recursive, and document-aware chunking
 */

export interface ChunkingConfig {
  strategy: 'fixed' | 'recursive' | 'semantic' | 'document-aware';
  chunkSize: number;
  overlap: number;
  separators?: string[];
  keepSeparator?: boolean;
}

export interface Chunk {
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  metadata: {
    strategy: string;
    tokenCount: number;
    hasCode?: boolean;
    hasHeaders?: boolean;
    section?: string;
  };
}

const DEFAULT_CONFIG: ChunkingConfig = {
  strategy: 'recursive',
  chunkSize: 500,
  overlap: 50,
  separators: ['\n\n', '\n', '. ', ' ', ''],
  keepSeparator: true,
};

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fixed-size chunking (basic)
 */
function fixedChunking(
  text: string,
  config: ChunkingConfig
): Chunk[] {
  const chunks: Chunk[] = [];
  const { chunkSize, overlap } = config;

  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const content = text.slice(start, end).trim();

    if (content.length > 0) {
      chunks.push({
        content,
        index,
        startOffset: start,
        endOffset: end,
        metadata: {
          strategy: 'fixed',
          tokenCount: estimateTokens(content),
        },
      });
      index++;
    }

    start = end - overlap;
    if (start + overlap >= text.length) break;
  }

  return chunks;
}

/**
 * Recursive chunking (LangChain-style)
 */
function recursiveChunking(
  text: string,
  config: ChunkingConfig
): Chunk[] {
  const {
    chunkSize,
    overlap,
    separators = ['\n\n', '\n', '. ', ' ', ''],
    keepSeparator = true,
  } = config;

  const chunks: Chunk[] = [];
  let index = 0;

  function splitRecursive(
    currentText: string,
    currentSeparators: string[],
    startOffset: number
  ): void {
    if (currentText.length <= chunkSize) {
      if (currentText.trim().length > 0) {
        chunks.push({
          content: currentText.trim(),
          index,
          startOffset,
          endOffset: startOffset + currentText.length,
          metadata: {
            strategy: 'recursive',
            tokenCount: estimateTokens(currentText),
          },
        });
        index++;
      }
      return;
    }

    // Try each separator
    for (let i = 0; i < currentSeparators.length; i++) {
      const sep = currentSeparators[i];
      const parts = currentText.split(sep);

      if (parts.length > 1) {
        let currentOffset = startOffset;

        for (let j = 0; j < parts.length; j++) {
          const part = parts[j];
          const partWithSep =
            j < parts.length - 1 ? part + (keepSeparator ? sep : '') : part;

          if (partWithSep.length > 0) {
            if (partWithSep.length <= chunkSize) {
              chunks.push({
                content: partWithSep.trim(),
                index,
                startOffset: currentOffset,
                endOffset: currentOffset + partWithSep.length,
                metadata: {
                  strategy: 'recursive',
                  tokenCount: estimateTokens(partWithSep),
                },
              });
              index++;
            } else {
              // Recurse with remaining separators
              splitRecursive(
                partWithSep,
                currentSeparators.slice(i + 1),
                currentOffset
              );
            }
          }

          currentOffset += partWithSep.length;
        }

        return;
      }
    }

    // No separator found, force split
    const content = currentText.slice(0, chunkSize).trim();
    if (content.length > 0) {
      chunks.push({
        content,
        index,
        startOffset,
        endOffset: startOffset + chunkSize,
        metadata: {
          strategy: 'recursive',
          tokenCount: estimateTokens(content),
        },
      });
      index++;
    }

    const remaining = currentText.slice(chunkSize - overlap);
    if (remaining.trim().length > 0) {
      splitRecursive(remaining, currentSeparators, startOffset + chunkSize - overlap);
    }
  }

  splitRecursive(text, separators, 0);
  return chunks;
}

/**
 * Semantic chunking (sentence-based with similarity)
 */
function semanticChunking(
  text: string,
  config: ChunkingConfig
): Chunk[] {
  const { chunkSize, overlap } = config;

  // Split into sentences first
  const sentenceRegex = /[^.!?]+[.!?]+/g;
  const sentences = text.match(sentenceRegex) || [text];

  const chunks: Chunk[] = [];
  let currentChunk = '';
  let currentStart = 0;
  let index = 0;

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    const potentialChunk = currentChunk
      ? `${currentChunk} ${trimmedSentence}`
      : trimmedSentence;

    // Check if adding this sentence would exceed chunk size
    if (
      potentialChunk.length > chunkSize &&
      currentChunk.length > 0
    ) {
      // Save current chunk
      chunks.push({
        content: currentChunk.trim(),
        index,
        startOffset: currentStart,
        endOffset: currentStart + currentChunk.length,
        metadata: {
          strategy: 'semantic',
          tokenCount: estimateTokens(currentChunk),
          hasHeaders: /^#+\s/.test(currentChunk),
        },
      });
      index++;

      // Start new chunk with overlap
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText
        ? `${overlapText} ${trimmedSentence}`
        : trimmedSentence;
      currentStart = currentStart + currentChunk.length - overlapText.length;
    } else {
      currentChunk = potentialChunk;
    }
  }

  // Add final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      index,
      startOffset: currentStart,
      endOffset: currentStart + currentChunk.length,
      metadata: {
        strategy: 'semantic',
        tokenCount: estimateTokens(currentChunk),
      },
    });
  }

  return chunks;
}

/**
 * Document-aware chunking (respects document structure)
 */
function documentAwareChunking(
  text: string,
  config: ChunkingConfig
): Chunk[] {
  const { chunkSize, overlap } = config;

  // Detect document structure
  const headerRegex = /^#{1,6}\s+.+$/gm;
  const codeBlockRegex = /```[\s\S]*?```/g;
  const listRegex = /^[\s]*[-*+]\s+.+$/gm;

  const chunks: Chunk[] = [];
  let index = 0;

  // Split by headers first
  const sections = text.split(/^(#{1,6}\s+.+)$/m);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const isHeader = /^#{1,6}\s+/.test(section);

    if (isHeader) {
      // Header + next section
      const nextSection = sections[i + 1] || '';
      const fullSection = `${section}\n${nextSection}`;

      if (fullSection.length <= chunkSize) {
        chunks.push({
          content: fullSection.trim(),
          index,
          startOffset: text.indexOf(section),
          endOffset: text.indexOf(section) + fullSection.length,
          metadata: {
            strategy: 'document-aware',
            tokenCount: estimateTokens(fullSection),
            hasHeaders: true,
            section: section.replace(/^#+\s+/, ''),
          },
        });
        index++;
        i++; // Skip next section
      } else {
        // Section too large, split further
        const subChunks = recursiveChunking(fullSection, {
          ...config,
          strategy: 'recursive',
        });

        for (const chunk of subChunks) {
          chunks.push({
            ...chunk,
            index,
            metadata: {
              ...chunk.metadata,
              strategy: 'document-aware',
              section: section.replace(/^#+\s+/, ''),
            },
          });
          index++;
        }
        i++;
      }
    } else if (section.trim().length > 0) {
      // Regular content
      if (section.length <= chunkSize) {
        chunks.push({
          content: section.trim(),
          index,
          startOffset: text.indexOf(section),
          endOffset: text.indexOf(section) + section.length,
          metadata: {
            strategy: 'document-aware',
            tokenCount: estimateTokens(section),
            hasCode: codeBlockRegex.test(section),
            hasHeaders: headerRegex.test(section),
          },
        });
        index++;
      } else {
        const subChunks = recursiveChunking(section, {
          ...config,
          strategy: 'recursive',
        });

        for (const chunk of subChunks) {
          chunks.push({
            ...chunk,
            index,
            metadata: {
              ...chunk.metadata,
              strategy: 'document-aware',
              hasCode: codeBlockRegex.test(chunk.content),
            },
          });
          index++;
        }
      }
    }
  }

  return chunks;
}

/**
 * Main chunking function
 */
export function chunkDocument(
  text: string,
  config: Partial<ChunkingConfig> = {}
): Chunk[] {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  switch (fullConfig.strategy) {
    case 'fixed':
      return fixedChunking(text, fullConfig);
    case 'recursive':
      return recursiveChunking(text, fullConfig);
    case 'semantic':
      return semanticChunking(text, fullConfig);
    case 'document-aware':
      return documentAwareChunking(text, fullConfig);
    default:
      return recursiveChunking(text, fullConfig);
  }
}

/**
 * Compare chunking strategies
 */
export function compareChunkingStrategies(
  text: string,
  configs: ChunkingConfig[]
): Map<string, Chunk[]> {
  const results = new Map<string, Chunk[]>();

  for (const config of configs) {
    const chunks = chunkDocument(text, config);
    results.set(config.strategy, chunks);
  }

  return results;
}

/**
 * Get chunking statistics
 */
export function getChunkingStats(chunks: Chunk[]): {
  totalChunks: number;
  avgChunkSize: number;
  minChunkSize: number;
  maxChunkSize: number;
  totalTokens: number;
} {
  const sizes = chunks.map((c) => c.content.length);
  const tokens = chunks.reduce((sum, c) => sum + c.metadata.tokenCount, 0);

  return {
    totalChunks: chunks.length,
    avgChunkSize: sizes.reduce((a, b) => a + b, 0) / sizes.length || 0,
    minChunkSize: Math.min(...sizes),
    maxChunkSize: Math.max(...sizes),
    totalTokens: tokens,
  };
}
