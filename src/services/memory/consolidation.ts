import type { EpisodicMemory, SemanticMemory, KnowledgeGraphNode } from '../../types/memory';
import { EpisodicMemoryStore } from './episodic';
import { SemanticMemoryStore } from './semantic';
import { KnowledgeGraphStore } from './knowledge-graph';

interface ConsolidationResult {
  episodic_count: number;
  semantic_created: number;
  nodes_created: number;
  edges_created: number;
}

export class MemoryConsolidator {
  private episodic: EpisodicMemoryStore;
  private semantic: SemanticMemoryStore;
  private kg: KnowledgeGraphStore;

  constructor(private db: D1Database) {
    this.episodic = new EpisodicMemoryStore(db);
    this.semantic = new SemanticMemoryStore(db);
    this.kg = new KnowledgeGraphStore(db);
  }

  async consolidate(userId: string): Promise<ConsolidationResult> {
    const staleEpisodes = await this.episodic.getStale(userId, 7, 50);

    if (staleEpisodes.length === 0) {
      return { episodic_count: 0, semantic_created: 0, nodes_created: 0, edges_created: 0 };
    }

    let semanticCreated = 0;
    let nodesCreated = 0;
    let edgesCreated = 0;

    // Extract semantic facts from episodic clusters
    const facts = this.extractFacts(staleEpisodes);

    for (const fact of facts) {
      const existing = await this.semantic.search(userId, fact.fact, 1);
      if (existing.length > 0 && existing[0].confidence >= fact.confidence) {
        continue;
      }

      await this.semantic.create({
        user_id: userId,
        fact: fact.fact,
        category: fact.category,
        confidence: fact.confidence,
        source_episodic_id: fact.source_episodic_id,
        source_type: 'consolidated',
      });
      semanticCreated++;
    }

    // Build knowledge graph from episodes
    const graphResult = this.buildGraphFromEpisodes(staleEpisodes, userId);
    for (const nodeInput of graphResult.nodes) {
      const existing = await this.kg.findNode(userId, nodeInput.name, nodeInput.type);
      if (!existing) {
        await this.kg.createNode(nodeInput);
        nodesCreated++;
      }
    }

    for (const edgeInput of graphResult.edges) {
      const existingEdges = await this.kg.listEdges(userId, edgeInput.source_node_id);
      const duplicate = existingEdges.find(
        e => e.target_node_id === edgeInput.target_node_id && e.relationship === edgeInput.relationship
      );
      if (!duplicate) {
        await this.kg.createEdge(edgeInput);
        edgesCreated++;
      }
    }

    // Mark episodes as consolidated
    const ids = staleEpisodes.map(e => e.id);
    await this.episodic.markConsolidated(ids);

    return {
      episodic_count: staleEpisodes.length,
      semantic_created: semanticCreated,
      nodes_created: nodesCreated,
      edges_created: edgesCreated,
    };
  }

  private extractFacts(episodes: EpisodicMemory[]): { fact: string; category: string; confidence: number; source_episodic_id: string }[] {
    const facts: { fact: string; category: string; confidence: number; source_episodic_id: string }[] = [];

    for (const ep of episodes) {
      const topics: string[] = (() => {
        try { return JSON.parse(ep.topics); } catch { return []; }
      })();

      // Extract topic-based facts
      for (const topic of topics) {
        facts.push({
          fact: `Topic discussed: ${topic}`,
          category: 'topics',
          confidence: 0.6,
          source_episodic_id: ep.id,
        });
      }

      // Extract outcome-based facts
      if (ep.outcome === 'positive') {
        facts.push({
          fact: `Positive interaction regarding: ${ep.summary}`,
          category: 'outcomes',
          confidence: 0.7,
          source_episodic_id: ep.id,
        });
      } else if (ep.outcome === 'negative') {
        facts.push({
          fact: `Negative interaction regarding: ${ep.summary}`,
          category: 'outcomes',
          confidence: 0.7,
          source_episodic_id: ep.id,
        });
      }

      // Extract high-importance content as facts
      if (ep.importance >= 0.7) {
        facts.push({
          fact: ep.summary,
          category: 'important',
          confidence: ep.importance,
          source_episodic_id: ep.id,
        });
      }
    }

    return facts;
  }

  private buildGraphFromEpisodes(
    episodes: EpisodicMemory[],
    userId: string
  ): {
    nodes: { user_id: string; name: string; type: string; description: string }[];
    edges: { user_id: string; source_node_id: string; target_node_id: string; relationship: string; weight: number }[];
  } {
    const nodeMap = new Map<string, { name: string; type: string; description: string }>();
    const edgeList: { source_node_id: string; target_node_id: string; relationship: string; weight: number }[] = [];

    for (const ep of episodes) {
      const topics: string[] = (() => {
        try { return JSON.parse(ep.topics); } catch { return []; }
      })();

      // Create topic nodes
      for (const topic of topics) {
        const key = `topic:${topic}`;
        if (!nodeMap.has(key)) {
          nodeMap.set(key, { name: topic, type: 'topic', description: `Topic: ${topic}` });
        }
      }

      // Create episode node
      const epKey = `episode:${ep.id}`;
      nodeMap.set(epKey, {
        name: ep.summary.slice(0, 100),
        type: 'episode',
        description: ep.content.slice(0, 500),
      });

      // Connect episodes to their topics
      for (const topic of topics) {
        const topicKey = `topic:${topic}`;
        if (nodeMap.has(epKey) && nodeMap.has(topicKey)) {
          edgeList.push({
            source_node_id: epKey,
            target_node_id: topicKey,
            relationship: 'discusses',
            weight: ep.importance,
          });
        }
      }

      // Connect sequential episodes (temporal chain)
      const prevEp = episodes[episodes.indexOf(ep) - 1];
      if (prevEp) {
        edgeList.push({
          source_node_id: `episode:${prevEp.id}`,
          target_node_id: epKey,
          relationship: 'follows',
          weight: 0.5,
        });
      }
    }

    // Connect related topics
    const topicKeys = [...nodeMap.keys()].filter(k => k.startsWith('topic:'));
    for (let i = 0; i < topicKeys.length; i++) {
      for (let j = i + 1; j < topicKeys.length; j++) {
        // Check co-occurrence in episodes
        const topic1 = topicKeys[i].replace('topic:', '');
        const topic2 = topicKeys[j].replace('topic:', '');
        const coOccurrences = episodes.filter(ep => {
          const topics: string[] = (() => {
            try { return JSON.parse(ep.topics); } catch { return []; }
          })();
          return topics.includes(topic1) && topics.includes(topic2);
        }).length;

        if (coOccurrences > 0) {
          edgeList.push({
            source_node_id: topicKeys[i],
            target_node_id: topicKeys[j],
            relationship: 'related_to',
            weight: Math.min(1, coOccurrences * 0.3),
          });
        }
      }
    }

    const nodes = [...nodeMap.entries()].map(([key, val]) => ({
      user_id: userId,
      ...val,
    }));

    const edges = edgeList.map(e => ({ user_id: userId, ...e }));

    return { nodes, edges };
  }
}
