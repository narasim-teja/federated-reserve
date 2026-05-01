/**
 * Tilegrid layout for the 50 US states + DC + PR. Coordinates are
 * [row, col] with the grid sized 8 × 12. Inspired by the FT/NYT
 * cartogram convention — preserves geographic relationships while
 * giving every state equal visual weight, which matches the
 * intelligence-dashboard aesthetic better than a true projection.
 */
export const STATE_TILE: Record<string, [number, number]> = {
  // Row 0 — Alaska parked top-left, Maine top-right
  AK: [0, 0],
  ME: [0, 11],
  // Row 1 — northern New England
  VT: [1, 10],
  NH: [1, 11],
  // Row 2 — northern tier
  WA: [2, 1],
  ID: [2, 2],
  MT: [2, 3],
  ND: [2, 4],
  MN: [2, 5],
  WI: [2, 6],
  MI: [2, 7],
  NY: [2, 9],
  MA: [2, 10],
  RI: [2, 11],
  // Row 3
  OR: [3, 1],
  NV: [3, 2],
  WY: [3, 3],
  SD: [3, 4],
  IA: [3, 5],
  IL: [3, 6],
  IN: [3, 7],
  OH: [3, 8],
  PA: [3, 9],
  NJ: [3, 10],
  CT: [3, 11],
  // Row 4
  CA: [4, 1],
  UT: [4, 2],
  CO: [4, 3],
  NE: [4, 4],
  MO: [4, 5],
  KY: [4, 6],
  WV: [4, 7],
  VA: [4, 8],
  MD: [4, 9],
  DE: [4, 10],
  // Row 5
  AZ: [5, 2],
  NM: [5, 3],
  KS: [5, 4],
  AR: [5, 5],
  TN: [5, 6],
  NC: [5, 7],
  SC: [5, 8],
  DC: [5, 9],
  // Row 6
  HI: [6, 0],
  OK: [6, 4],
  LA: [6, 5],
  MS: [6, 6],
  AL: [6, 7],
  GA: [6, 8],
  // Row 7
  TX: [7, 4],
  FL: [7, 8],
  PR: [7, 11],
};

export const TILE_ROWS = 8;
export const TILE_COLS = 12;
