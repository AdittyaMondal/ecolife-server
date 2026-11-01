import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import * as repo from './gamification.repository.ts';

/**
 * Business rules for the gamification read surface (PRD-v2 §4.5).
 *
 * The catalogue is public, for the same reason `/carbon/methodology` is: a
 * reward economy nobody can inspect before joining is not a credibility
 * surface, it is a pitch.
 */

export type RarityView = {
  id: number;
  slug: string;
  name: string;
  rank: number;
  dropWeight: number;
  isActive: boolean;
};

export type TreeView = {
  id: number;
  slug: string;
  name: string;
  description: string;
  rarity: RarityView;
  imageUrl: string;
  growthStages: { stage: number; label: string; imageUrl: string }[] | null;
  co2OffsetKgPerYear: number;
  isActive: boolean;
};

type JoinedTree = { tree: Omit<TreeView, 'rarity'>; rarity: RarityView };

function serialiseTree(row: JoinedTree): TreeView {
  return { ...row.tree, growthStages: row.tree.growthStages ?? null, rarity: row.rarity };
}

export async function listRarities(includeInactive = false): Promise<{ items: RarityView[] }> {
  return { items: await repo.listRarities(includeInactive) };
}

export async function listTrees(
  query: { rarity?: string; cursor?: string; limit: number },
  includeInactive = false,
): Promise<Page<TreeView>> {
  /**
   * An unknown rarity slug is an empty page, not a 404. The filter names a
   * facet the caller picked off a list; answering 404 would make a stale
   * client's filter look like a broken catalogue.
   */
  let rarityId: number | undefined;
  if (query.rarity !== undefined) {
    const rarity = await repo.findRarityBySlug(query.rarity);
    if (!rarity) return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
    rarityId = rarity.id;
  }

  const rows = await repo.listTrees({
    rarityId,
    includeInactive,
    afterId: decodeIdCursor(query.cursor),
    limit: query.limit,
  });
  const page = toPage(rows, query.limit, (r) => r.tree.id);
  return { items: page.items.map(serialiseTree), pageInfo: page.pageInfo };
}

export async function treeBySlug(slug: string, includeInactive = false): Promise<TreeView> {
  const row = await repo.findTreeBySlug(slug, includeInactive);
  if (!row) throw new DomainError('GAME_001', 'No tree in the catalogue with that slug.', 404);
  return serialiseTree(row);
}
