export const NODE4_API_VERSION = "v1" as const;
export const NODE4_GLOBAL_RANGES = ["24H", "7D", "30D"] as const;
export type Node4GlobalRange = (typeof NODE4_GLOBAL_RANGES)[number];
