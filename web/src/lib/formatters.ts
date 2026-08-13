import { get } from 'svelte/store';
import { is24Hour } from '../shell/state/time';

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString();
}

export function formatTime(isoString?: string | number | Date, override24Hour?: boolean): string {
  if (!isoString) return '';
  const date = isoString instanceof Date ? isoString : new Date(isoString);
  if (isNaN(date.getTime())) return '';

  const use24 = override24Hour ?? get(is24Hour);

  if (use24) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function formatRelativeTime(dateStr: Date | string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDate(isoString?: string | number | Date): string {
  if (!isoString) return '';
  const date = isoString instanceof Date ? isoString : new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}
