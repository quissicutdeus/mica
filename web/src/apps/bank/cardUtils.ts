/**
 * Generates a deterministic 16-digit credit card number from a string identifier (e.g. citizenid or player name).
 * Uses FNV-1a hashing combined with a Linear Congruential Generator (LCG) for uniform entropy.
 */
export function hashStringToCardNumber(input: string): string {
  if (!input) return '4242 4242 4242 4242';

  // FNV-1a 32-bit hash algorithm
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  // Unsigned 32-bit seed
  let seed = hash >>> 0;

  // LCG pseudo-random generator seeded by string hash
  const lcg = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed;
  };

  // Standard card prefix: 4 (Visa style)
  const digits: number[] = [4];
  for (let i = 1; i < 16; i++) {
    digits.push(lcg() % 10);
  }

  const fullCard = digits.join('');
  return `${fullCard.slice(0, 4)} ${fullCard.slice(4, 8)} ${fullCard.slice(8, 12)} ${fullCard.slice(12, 16)}`;
}
