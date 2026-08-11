/**
 * The hybrid emoji picker's data: a fixed palette row plus a small full catalog behind "+".
 *
 * A static bundled list rather than a package or a network call — the hard constraint against
 * new dependencies (AGENTS.md §2.5) and the fact that this never needs to be exhaustive, only
 * broad enough that "+" reads as a real picker rather than a second copy of the palette.
 */

/** The always-visible row. Common reactions, in the order a reader scans them. */
export const EMOJI_PALETTE: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '😡'];

export interface EmojiCategory {
  label: string;
  emoji: readonly string[];
}

/** Behind "+". Grouped so a long list reads as sections instead of one undifferentiated grid. */
export const EMOJI_CATALOG: readonly EmojiCategory[] = [
  {
    label: 'Smileys',
    emoji: [
      '😀',
      '😁',
      '😆',
      '😅',
      '🥹',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '😘',
      '😋',
      '😛',
      '🤪',
      '🤨',
      '🧐',
      '🤓',
      '😎',
      '🥳',
      '😏',
      '😒',
      '😞',
      '😔',
      '😟',
      '😕',
      '🙁',
      '😣',
      '😖',
      '😫',
      '😩',
      '🥺',
      '😤',
      '😠',
      '🤬',
      '😳',
      '🥵',
      '🥶',
      '😱',
      '😨',
      '😰',
      '😥',
      '😓',
      '🤔',
      '🤫',
      '🤐',
      '🥴',
      '😴',
      '🤤',
      '😷',
      '🤒',
      '🤢',
      '🥱',
      '😈',
      '👻',
      '💀',
      '🤖',
      '🤡'
    ]
  },
  {
    label: 'Gestures',
    emoji: [
      '👍',
      '👎',
      '👏',
      '🙌',
      '🙏',
      '🤝',
      '👋',
      '🤙',
      '💪',
      '🤞',
      '✌️',
      '🤟',
      '👌',
      '☝️',
      '👆',
      '👉',
      '👈',
      '✋',
      '🤚',
      '🖐️'
    ]
  },
  {
    label: 'Hearts',
    emoji: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '🤍',
      '🤎',
      '💔',
      '❣️',
      '💕',
      '💞',
      '💓',
      '💗',
      '💖',
      '💘',
      '💝'
    ]
  },
  {
    label: 'Reactions',
    emoji: ['🔥', '💯', '✨', '🎉', '🎊', '👀', '💀', '😭', '🫠', '🤯', '🫡', '🤌', '🙄', '😬']
  },
  {
    label: 'Animals',
    emoji: [
      '🐶',
      '🐱',
      '🐭',
      '🐹',
      '🐰',
      '🦊',
      '🐻',
      '🐼',
      '🐨',
      '🐯',
      '🦁',
      '🐮',
      '🐷',
      '🐸',
      '🐵',
      '🐔',
      '🐧',
      '🐦',
      '🦆',
      '🦉'
    ]
  },
  {
    label: 'Food',
    emoji: [
      '🍕',
      '🍔',
      '🍟',
      '🌭',
      '🌮',
      '🍣',
      '🍜',
      '🍩',
      '🍪',
      '🍰',
      '🍺',
      '🍷',
      '☕',
      '🍎',
      '🍌',
      '🍇'
    ]
  }
];
