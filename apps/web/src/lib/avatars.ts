/** Gradient pairs for avatars — cycled via hash of sender string. */
export const AVATAR_GRADIENTS = [
  'from-[#c084fc] to-[#818cf8]', // purple → indigo
  'from-[#34d399] to-[#3b82f6]', // emerald → blue
  'from-[#fb923c] to-[#f472b6]', // orange → pink
  'from-[#60a5fa] to-[#818cf8]', // blue → indigo
  'from-[#a78bfa] to-[#c084fc]', // violet → purple
  'from-[#f472b6] to-[#fb923c]', // pink → orange
  'from-[#22d3ee] to-[#818cf8]', // cyan → indigo
  'from-[#fbbf24] to-[#f472b6]', // amber → pink
];

/** Simple hash to get a stable avatar gradient from a string. */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Get the gradient class for a sender name. */
export function getAvatarGradient(name: string): string {
  return AVATAR_GRADIENTS[hashString(name) % AVATAR_GRADIENTS.length];
}
