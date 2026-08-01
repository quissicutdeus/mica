/**
 * Stand-in viewfinder frames for browser development.
 *
 * In game the viewfinder is the world showing through a transparent NUI, so there is
 * nothing to load. A browser has no world, and a black rectangle makes the whole app
 * look broken while developing.
 *
 * Held here rather than pulled from `web/src/mocks/`. An app reaching into the shell's
 * mock registry does not resolve for an add-on installed from the Store, and
 * re-exporting from there would satisfy the letter of that rule while breaking it — the
 * import still crosses the boundary, just one file further away. These are the camera's
 * own dev fixtures and nothing else reads them.
 */
export const sampleAvatars = [
  'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=500&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=500&auto=format&fit=crop&q=80'
];
