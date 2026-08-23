import type { NotificationItem } from '@shared/types';

export interface NotificationConversationGroup {
  title: string;
  items: NotificationItem[];
  latest: NotificationItem;
}

/**
 * Groups notification items by `title` — the sender/conversation identity — rather than
 * listing every individual item. Twelve texts from the same person become one group;
 * `items` stays newest-first so `latest` is always `items[0]`.
 */
export function groupNotificationsByConversation(
  items: NotificationItem[]
): NotificationConversationGroup[] {
  const byTitle = new Map<string, NotificationItem[]>();
  for (const item of items) {
    const list = byTitle.get(item.title) || [];
    list.push(item);
    byTitle.set(item.title, list);
  }

  const groups: NotificationConversationGroup[] = [];
  byTitle.forEach((groupItems, title) => {
    const sorted = [...groupItems].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    groups.push({ title, items: sorted, latest: sorted[0] });
  });

  groups.sort(
    (a, b) => new Date(b.latest.created_at).getTime() - new Date(a.latest.created_at).getTime()
  );

  return groups;
}
