/**
 * Small pixel-art icons, drawn as 12x12 character grids and rendered to crisp SVG.
 * Letters are colours: k = outline (follows the text colour), w = light, o = orange,
 * b = blue, g = green, y = gold, d = dark wood, p = light wood, s = steel, n = grey.
 */
import type { CSSProperties } from 'react';
import type { Look } from '../types';

const PALETTE: Record<string, string> = {
  k: 'currentColor',
  w: '#FBF3DE',
  o: '#C4562A',
  b: '#2F6FA8',
  g: '#5E9B47',
  y: '#E3A72F',
  d: '#6E4524',
  p: '#E8C39A',
  s: '#9FB3C8',
  n: '#9E9483',
};

const GRIDS = {
  house: ['.....kk.....', '....kook....', '...kooook...', '..kooooook..', '.kooooooook.', 'kkkkkkkkkkkk', '.kwwwwwwwwk.', '.kwbbwwddwk.', '.kwbbwwddwk.', '.kwwwwwddwk.', '.kkkkkkkkkk.', '............'],
  car: ['............', '............', '...kkkkkk...', '..kssksssk..', '.kkssksssk..', 'kooooooooook', 'koooooooooyk', 'kooooooooook', 'kkkkkkkkkkkk', '..kdk..kdk..', '...k....k...', '............'],
  scooter: ['........kk..', '........kk..', '.........k..', '.........k..', '.........k..', '.........k..', '........k...', '........k...', 'kkkkkkkkk...', 'kbbbbbbbk...', '.kk....kk...', '.kk....kk...'],
  datacenter: ['.kkkkkkkkkk.', '.kssssssssk.', '.ksgskssssk.', '.kssssssssk.', '.kkkkkkkkkk.', '.kssssssssk.', '.ksyskssssk.', '.kssssssssk.', '.kkkkkkkkkk.', '.kssssssssk.', '.ksgskssssk.', '.kkkkkkkkkk.'],
  pencil: ['.........kk.', '........kook', '.......kyyok', '......kyyyk.', '.....kyyyk..', '....kyyyk...', '...kyyyk....', '..kyyyk.....', '.kpyyk......', '.kppk.......', '.kkk........', '............'],
  people: ['............', '..kk....kk..', '.kppk..kppk.', '.kppk..kppk.', '..kk....kk..', '.kbbk..kook.', 'kbbbbkkooook', 'kbbbbkkooook', 'kbbbbkkooook', '.kbbk..kook.', '.k..k..k..k.', '............'],
  ballot: ['...kkkkkk...', '...kwwwwk...', '...kwbbwk...', '...kwwwwk...', 'kkkkkkkkkkkk', 'kpppkkkkpppk', 'kppppppppppk', 'kppppppppppk', 'kppppppppppk', 'kppppppppppk', 'kkkkkkkkkkkk', '............'],
  walk: ['......kk....', '.....kppk...', '.....kppk...', '......kk....', '.....kyyk...', '....kyyyyk..', '...k.kyyk.k.', '.....kyyk...', '....kk..kk..', '...kk....kk.', '..kk......k.', '............'],
  chat: ['............', '.kkkkkkkkkk.', 'kwwwwwwwwwwk', 'kwkkwkkwkwwk', 'kwwwwwwwwwwk', 'kwkkkwkkkwwk', 'kwwwwwwwwwwk', '.kkkwkkkkkk.', '...kwk......', '...kk.......', '...k........', '............'],
  info: ['...kkkkkk...', '..kwwwwwwk..', '.kwwwkkwwwk.', 'kwwwwkkwwwwk', 'kwwwwwwwwwwk', 'kwwwkkkwwwwk', 'kwwwwkkwwwwk', 'kwwwwkkwwwwk', '.kwwkkkkwwk.', '..kwwwwwwk..', '...kkkkkk...', '............'],
  close: ['............', '.kk......kk.', '.kkk....kkk.', '..kkk..kkk..', '...kkkkkk...', '....kkkk....', '....kkkk....', '...kkkkkk...', '..kkk..kkk..', '.kkk....kkk.', '.kk......kk.', '............'],
  check: ['............', '..........kk', '.........kk.', '........kk..', '.......kk...', 'kk....kk....', '.kk..kk.....', '..kkkk......', '...kk.......', '............', '............', '............'],
  left: ['............', '.....kk.....', '....kk......', '...kk.......', '..kkkkkkkk..', '.kkkkkkkkk..', '..kkkkkkkk..', '...kk.......', '....kk......', '.....kk.....', '............', '............'],
  right: ['............', '.....kk.....', '......kk....', '.......kk...', '..kkkkkkkk..', '..kkkkkkkkk.', '..kkkkkkkk..', '.......kk...', '......kk....', '.....kk.....', '............', '............'],
  pin: ['...kkkkkk...', '..koooooook.', '.kooowwoook.', '.koowwwwook.', '.kooowwoook.', '..koooooook.', '...kooooook.', '....koook...', '.....kok....', '.....kk.....', '............', '............'],
  ghost: ['....kkkk....', '..kkwwwwkk..', '.kwwwwwwwwk.', '.kwkkwwkkwk.', '.kwkkwwkkwk.', '.kwwwwwwwwk.', '.kwwwkkwwwk.', '.kwwwwwwwwk.', '.kwwwwwwwwk.', '.kwkwwkwwkk.', '.kk.kk.kk...', '............'],
  noise: ['............', '.....k...k..', '....kk..k...', '...kwk.k..k.', 'kkkwwk..k.k.', 'kwwwwk..k.k.', 'kwwwwk..k.k.', 'kkkwwk..k.k.', '...kwk.k..k.', '....kk..k...', '.....k...k..', '............'],
  heat: ['...k...k....', '....k...k...', '...k...k....', '....k...k...', '............', 'kkkkkkkkkkkk', 'kokokokokook', 'kokokokokook', 'kokokokokook', 'kkkkkkkkkkkk', '.kk......kk.', '............'],
  job: ['............', '....kkkk....', '...k....k...', 'kkkkkkkkkkkk', 'kddddddddddk', 'kddddddddddk', 'kkkkkyykkkkk', 'kddddyyddddk', 'kddddddddddk', 'kddddddddddk', 'kkkkkkkkkkkk', '............'],
  money: ['...kkkkkk...', '..kyyyyyyk..', '.kyyykkyyyk.', 'kyyykyyyyyyk', 'kyykkkkkyyyk', 'kyyykyyyyyyk', 'kyykkkkkyyyk', 'kyyykyyyyyyk', '.kyyykkkyyk.', '..kyyyyyyk..', '...kkkkkk...', '............'],
  water: ['.....kk.....', '.....kk.....', '....kbbk....', '....kbbk....', '...kbbbbk...', '..kbbbbbbk..', '..kbwbbbbk..', '.kbwbbbbbbk.', '.kbwbbbbbbk.', '.kbbbbbbbbk.', '..kbbbbbbk..', '...kkkkkk...'],
  power: ['.....kkkkk..', '....kyyyk...', '...kyyyk....', '..kyyyk.....', '.kyyyykkkk..', '.kkkkyyyyk..', '.....kyyk...', '....kyyk....', '...kyyk.....', '...kyk......', '...kk.......', '............'],
  park: ['....kkkk....', '..kkggggkk..', '.kggggggggk.', 'kggggggggggk', 'kggggggggggk', 'kggggggggggk', '.kggggggggk.', '..kkkddkkk..', '.....dd.....', '.....dd.....', '...kkkkkk...', '............'],
  construction: ['.....kk.....', '....kook....', '....kook....', '...kwwwwk...', '...koooook..', '..koooooook.', '..kwwwwwwk..', '.kooooooook.', '.kooooooook.', 'kkkkkkkkkkkk', 'kddddddddddk', 'kkkkkkkkkkkk'],
  none: ['............', '............', '............', '............', '............', '..kkkkkkkk..', '..kkkkkkkk..', '............', '............', '............', '............', '............'],
  question: ['...kkkkkk...', '..kk....kk..', '..kk....kk..', '........kk..', '.......kk...', '.....kkk....', '.....kk.....', '.....kk.....', '............', '.....kk.....', '.....kk.....', '............'],
  map: ['............', 'kkkk..kkkk..', 'kggkkkbbbkkk', 'kgggkbbbkggk', 'kggkbbbkgggk', 'kgkbbbkggggk', 'kkbbbkgggygk', 'kbbbkggggggk', 'kbbkggggggkk', 'kkkkk..kkkk.', '............', '............'],
  play: ['............', '..kk........', '..kwkk......', '..kwwwkk....', '..kwwwwwkk..', '..kwwwwwwwk.', '..kwwwwwkk..', '..kwwwkk....', '..kwkk......', '..kk........', '............', '............'],
  eye: ['............', '............', '...kkkkkk...', '.kkwwwwwwkk.', 'kwwwwkkwwwwk', 'kwwwkbbkwwwk', 'kwwwkbbkwwwk', 'kwwwwkkwwwwk', '.kkwwwwwwkk.', '...kkkkkk...', '............', '............'],
  sparkle: ['.....k......', '.....k......', '....kyk.....', '..kkyyykk...', '....kyk.....', '.....k...k..', '.....k..kyk.', '.......kyyyk', '........kyk.', '.........k..', '............', '............'],
} as const;
// end grids

export type IconName = keyof typeof GRIDS | 'home' | 'tax';

const ALIASES: Partial<Record<IconName, keyof typeof GRIDS>> = { home: 'house', tax: 'money' };

/** Convert a grid into one SVG path per colour (horizontal runs merged). */
function gridPaths(grid: readonly string[]): { color: string; d: string }[] {
  const byColor = new Map<string, string[]>();
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.' || !PALETTE[ch]) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const list = byColor.get(ch) ?? [];
      list.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      byColor.set(ch, list);
      x = end;
    }
  });
  return [...byColor.entries()].map(([ch, parts]) => ({ color: PALETTE[ch], d: parts.join('') }));
}

const cache = new Map<string, { color: string; d: string }[]>();

export function Icon({ name, size = 18, title, className, style }: { name: IconName | string; size?: number; title?: string; className?: string; style?: CSSProperties }) {
  const key = (ALIASES[name as IconName] ?? name) as keyof typeof GRIDS;
  const grid = GRIDS[key] ?? GRIDS.question;
  let paths = cache.get(key);
  if (!paths) {
    paths = gridPaths(grid);
    cache.set(key, paths);
  }
  return (
    <svg
      className={`px-icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((p) => (
        <path key={p.color} fill={p.color} d={p.d} />
      ))}
    </svg>
  );
}

// ---------- fallback portrait (when the renderer does not provide renderPortrait) ----------

const SKIN = ['#F6D3B3', '#EBB98F', '#D69A6C', '#B77B4E', '#8E5A35', '#653E22'];
const HAIR = ['#2A1A0E', '#5A3A22', '#8C5A2B', '#C98A3E', '#E3C27A', '#A33A2A', '#3B3B4F', '#D9D4CC'];
const SHIRT = ['#2F6FA8', '#C4562A', '#5E9B47', '#E3A72F', '#7A4FA6', '#3B7F7A', '#B03A48', '#D9C6A0', '#4A4A5A', '#E07B9B', '#6E4524', '#F2EFE6'];

/** A tiny 12x12 face built from a resident's Look (skin, hair, shirt, accessory). */
export function PixelPortrait({ look, size = 72 }: { look: Look; size?: number }) {
  const skin = SKIN[look.skin % SKIN.length];
  const hair = HAIR[look.hair % HAIR.length];
  const shirt = SHIRT[look.shirt % SHIRT.length];
  const px: [number, number, number, number, string][] = [];
  const rect = (x: number, y: number, w: number, h: number, c: string) => px.push([x, y, w, h, c]);
  rect(0, 0, 12, 12, '#EFD9A7'); // background
  rect(3, 3, 6, 6, skin); // face
  rect(2, 5, 1, 2, skin); // ears
  rect(9, 5, 1, 2, skin);
  const style = look.hairStyle % 6;
  rect(3, 2, 6, 1, hair);
  if (style !== 5) rect(2, 3, 8, 1, hair);
  if (style === 1 || style === 3) rect(2, 4, 1, 4, hair), rect(9, 4, 1, 4, hair); // long
  if (style === 2) rect(4, 1, 4, 1, hair); // tall
  if (style === 3) rect(2, 8, 1, 2, hair), rect(9, 8, 1, 2, hair);
  if (style === 4) rect(3, 4, 2, 1, hair); // fringe
  rect(4, 5, 1, 1, '#2A1A0E'); // eyes
  rect(7, 5, 1, 1, '#2A1A0E');
  rect(5, 7, 2, 1, '#8E3B2E'); // mouth
  rect(2, 9, 8, 3, shirt); // shoulders
  rect(5, 9, 2, 1, skin); // neck
  if (look.accessory === 1) rect(3, 5, 6, 1, '#2A1A0E'), rect(4, 5, 1, 1, '#9FB3C8'), rect(7, 5, 1, 1, '#9FB3C8'); // glasses
  if (look.accessory === 2) rect(2, 1, 8, 2, '#6E4524'), rect(1, 3, 10, 1, '#6E4524'); // hat
  if (look.accessory === 3) rect(3, 1, 6, 2, '#C4562A'), rect(7, 3, 4, 1, '#C4562A'); // cap
  if (look.accessory === 4) rect(3, 9, 6, 1, '#E3A72F'); // scarf
  return (
    <svg className="px-portrait" width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      {px.map(([x, y, w, h, c], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={c} />
      ))}
    </svg>
  );
}

/** Small emote face for a stance (-2..2). */
export function StanceFace({ stance, size = 28 }: { stance: number; size?: number }) {
  const side = stance >= 1 ? 'support' : stance <= -1 ? 'oppose' : 'neutral';
  const fill = side === 'support' ? '#2F6FA8' : side === 'oppose' ? '#C4562A' : '#9E9483';
  // mouth shapes on a 12x12 grid
  const mouth: [number, number, number, number][] =
    stance >= 2
      ? [[3, 7, 6, 1], [4, 8, 4, 1], [2, 6, 1, 1], [9, 6, 1, 1]]
      : stance === 1
        ? [[4, 8, 4, 1], [3, 7, 1, 1], [8, 7, 1, 1]]
        : stance === 0
          ? [[4, 8, 4, 1]]
          : stance === -1
            ? [[4, 7, 4, 1], [3, 8, 1, 1], [8, 8, 1, 1]]
            : [[4, 7, 4, 1], [3, 8, 1, 1], [8, 8, 1, 1], [3, 3, 2, 1], [7, 3, 2, 1]];
  return (
    <svg className="px-face" width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="#3B2313" d="M3 0h6v1h2v2h1v6h-1v2h-2v1H3v-1H1V9H0V3h1V1h2z" />
      <path fill={fill} d="M3 1h6v1h1v1h1v6h-1v1H9v1H3v-1H2V9H1V3h1V2h1z" />
      <rect x="4" y="4" width="1" height="2" fill="#FBF3DE" />
      <rect x="7" y="4" width="1" height="2" fill="#FBF3DE" />
      {mouth.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill="#FBF3DE" />
      ))}
    </svg>
  );
}
