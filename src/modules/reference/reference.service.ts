import { METHODOLOGY } from '@common/carbon/methodology.ts';
import { DomainError } from '@common/errors/domain-error.ts';
import { decodeIdCursor, type Page, toPage } from '@common/pagination.ts';
import * as repo from './reference.repository.ts';

/** Reference data, the public methodology table, and in-app notifications. */

const CITY_RESULT_LIMIT = 20;

export function searchCities(q: string) {
  return repo.searchCities(q.trim(), CITY_RESULT_LIMIT);
}

export function listRegions() {
  return repo.listRegions();
}

/**
 * The public factor table.
 *
 * Served straight from `@common/carbon/methodology.ts`, not from a database
 * copy. A second copy is a second thing to forget to update, and this page's
 * whole purpose is that the numbers it shows are the numbers the engine used.
 */
export function methodology() {
  return {
    factorVersion: METHODOLOGY.factorVersion,
    updatedAt: METHODOLOGY.updatedAt,
    caveat: METHODOLOGY.caveat,
    factors: METHODOLOGY.factors.map((f) => ({
      key: f.key,
      value: f.value,
      unit: f.unit,
      basis: f.basis,
      source: f.source,
    })),
  };
}

export type NotificationView = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
};

export async function listNotifications(
  userId: number,
  limit: number,
  cursor: string | undefined,
): Promise<Page<NotificationView>> {
  const rows = await repo.listNotifications(userId, limit, decodeIdCursor(cursor));
  const page = toPage(rows, limit, (r) => r.id);
  return {
    items: page.items.map(serialise),
    pageInfo: page.pageInfo,
  };
}

export async function markRead(userId: number, id: number): Promise<NotificationView> {
  const row = await repo.markNotificationRead(userId, id);
  // Someone else's notification and a nonexistent one are the same 404 on
  // purpose: a 403 would confirm that the id exists.
  if (!row) throw new DomainError('NOTIF_001', 'Notification not found.', 404);
  return serialise(row);
}

export function unreadCount(userId: number) {
  return repo.countUnread(userId);
}

export const notify = repo.createNotification;

function serialise(row: {
  id: number;
  type: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    linkPath: row.linkPath,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
