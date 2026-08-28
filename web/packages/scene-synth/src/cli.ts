import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeOpm } from './format/opm.js';
import { encodePly } from './format/ply.js';
import { DEFAULT_GENERATE, POINT_LADDER, generatePointMap } from './generate.js';
import { buildFixtureScene, serializeScene } from './island-fixture.js';

/**
 * Generate the bake-off fixtures.
 *
 *   pnpm synth --out ./fixtures
 *   pnpm synth --out ./fixtures --counts 1000000 --ply
 *   pnpm synth --out ./fixtures --seed 7
 *
 * Output is deterministic: same seed, same bytes, on any machine. That is a hard requirement for
 * ADR-0003, because two renderer bindings measured on two different point clouds have not been
 * compared.
 */

interface Args {
  out: string;
  counts: number[];
  seed: number;
  ply: boolean;
  islands: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    out: 'fixtures',
    counts: [...POINT_LADDER],
    seed: DEFAULT_GENERATE.seed,
    ply: false,
    islands: 3,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] ?? args.out;
    else if (a === '--counts') {
      args.counts = (argv[++i] ?? '').split(',').map((s) => Number.parseInt(s.trim(), 10));
    } else if (a === '--seed') args.seed = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--islands') args.islands = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--ply') args.ply = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: synth [--out DIR] [--counts N,N,...] [--seed N] [--islands N] [--ply]\n',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${String(a)}`);
  }
  if (args.counts.some((c) => !Number.isFinite(c) || c <= 0)) {
    throw new Error('--counts must be positive integers');
  }
  return args;
}

const label = (n: number): string =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });

  const scene = buildFixtureScene(args.islands);
  writeFileSync(
    resolve(outDir, 'harbour-scene.json'),
    `${JSON.stringify(serializeScene(scene), null, 2)}\n`,
  );

  process.stdout.write(
    `points     source image   valid%   holes%   MB     s\n` +
      `---------  -------------  -------  -------  -----  -----\n`,
  );

  for (const target of args.counts) {
    const result = generatePointMap({ targetPoints: target, seed: args.seed });
    const name = `harbour-${label(target)}`;

    const opm = encodeOpm(result.points, result.meta);
    writeFileSync(resolve(outDir, `${name}.opm`), opm);

    const header = {
      ...result.meta,
      pointCount: result.points.count,
      bounds: { min: result.points.min, max: result.points.max },
    };
    writeFileSync(
      resolve(outDir, `${name}.meta.json`),
      `${JSON.stringify(header, null, 2)}\n`,
    );

    if (args.ply) {
      writeFileSync(
        resolve(outDir, `${name}.ply`),
        encodePly(result.points, `orimera synthetic point map, seed ${args.seed}`),
      );
    }

    const s = result.meta.statistics;
    const holes = 1 - s.pixelsSurviving! / s.sourcePixels!;
    process.stdout.write(
      `${label(target).padEnd(9)}  ` +
        `${`${result.sourceWidth}x${result.sourceHeight}`.padEnd(13)}  ` +
        `${(result.validFraction * 100).toFixed(1).padStart(6)}%  ` +
        `${(holes * 100).toFixed(1).padStart(6)}%  ` +
        `${(opm.byteLength / 1e6).toFixed(1).padStart(5)}  ` +
        `${(result.elapsedMs / 1000).toFixed(1).padStart(5)}\n`,
    );
  }

  process.stdout.write(`\nwrote ${args.counts.length} point maps to ${outDir}\n`);
}

main();
