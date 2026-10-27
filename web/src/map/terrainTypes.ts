/** Tile type codes used inside the renderer (mapped by NAME from map.tileTypes, so order changes are safe). */
export const TT = {
  outside: 0,
  water: 1,
  grass: 2,
  park: 3,
  forest: 4,
  plaza: 5,
  haussmann: 6,
  house: 7,
  tower: 8,
  industrial: 9,
  ring: 10,
  rail: 11,
  street: 12,
} as const;

/** Size of one tile in world pixels. */
export const TS = 16;

const NAME_TO_TT: Record<string, number> = {
  outside: TT.outside,
  water: TT.water,
  grass: TT.grass,
  park: TT.park,
  forest: TT.forest,
  plaza: TT.plaza,
  haussmann: TT.haussmann,
  suburb_house: TT.house,
  suburb_tower: TT.tower,
  industrial: TT.industrial,
  ring_road: TT.ring,
  rail: TT.rail,
  street: TT.street,
};

/** Build a lookup table: map.json tile index -> our TT code. Unknown names fall back to grass. */
export function tileTypeTable(names: string[]): Uint8Array {
  const table = new Uint8Array(Math.max(names.length, 1));
  names.forEach((n, i) => {
    table[i] = NAME_TO_TT[n] ?? TT.grass;
  });
  return table;
}

/** Can a villager stand / stroll here? (used for wandering targets and conversation spots) */
export function isWalkable(t: number): boolean {
  return t === TT.street || t === TT.plaza || t === TT.park || t === TT.grass || t === TT.haussmann || t === TT.house || t === TT.tower;
}
