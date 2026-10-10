import { parseArgs } from 'node:util';
import { copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { translate } from './i18n/index.ts';
import type { Engine } from './core/engine.ts';
import type { Matrix, Progress } from './core/types.ts';

const help = `Revia - local image compositing

Usage:
  npm run cli -- -i original.png -e edited.png -o result.png
  pnpm cli -i original.png -e edited.png -o result.png
  node scripts/cli.mjs -i original.png -e edited.png -o mask.png -f mask

Input and output:
  -i, --original <path>         Original image (required)
  -e, --edited <path>           AI-edited image (required)
  -o, --output <path>           Output file (required)
  -f, --format <png|mask|psd>   Infer png or psd from the extension if omitted
      --original-frame <n>     Original animation frame, starting at 1 (default: 1)
      --edited-frame <n>       Edited animation frame, starting at 1 (default: 1)

Processing:
      --align <auto|none>      Automatic position alignment (default: auto)
      --offset-x <px>          Extra horizontal shift, positive right (default: 0)
      --offset-y <px>          Extra vertical shift, positive down (default: 0)
      --rotation <degrees>     Extra rotation, positive clockwise (default: 0)
      --scale <factor>         Extra scale, greater than 0 (default: 1)
      --local-warp <auto|off>  Local boundary alignment (default: auto)
      --color-strength <0..1> Color matching strength, 0 disables it (default: 1)
      --sensitivity <0.5..1.6> Change detection sensitivity (default: 1)
      --feather <px>           Mask edge feathering, 0 disables it (default: 2)

Control:
      --overwrite             Replace an existing output file
  -q, --quiet                 Hide progress and completion messages
  -h, --help                  Show this help
  -v, --version               Show the version

Position adjustments use original-image pixels, after automatic alignment.
Scale and rotation share the original canvas center, followed by translation.
Colors and the mask are calculated at the final position. --align none also
disables local warping. Mask output is a 16-bit PNG; PSD supports 8-bit input
with a supported color profile. Output retains the original dimensions.

Examples:
  npm run cli -- -i original.png -e edited.png -o result.png --color-strength 0.8
  pnpm cli -i original.png -e edited.png -o result.png --sensitivity 1.2 --offset-x -2
`;

class UsageError extends Error {}
const numericOptions = new Set(['original-frame', 'edited-frame', 'offset-x', 'offset-y', 'rotation', 'scale', 'color-strength', 'sensitivity', 'feather']);

function parseOptions(args: string[]) {
  // Node's argument parser otherwise treats a separate negative number as an option.
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index], next = args[index + 1];
    if (numericOptions.has(argument.slice(2)) && argument.startsWith('--') && next?.startsWith('-') && Number.isFinite(Number(next))) {
      normalized.push(`${argument}=${next}`); index++;
    } else normalized.push(argument);
  }
  const { values } = parseArgs({ args: normalized, options: {
    original: { type: 'string', short: 'i' }, edited: { type: 'string', short: 'e' }, output: { type: 'string', short: 'o' }, format: { type: 'string', short: 'f' },
    'original-frame': { type: 'string', default: '1' }, 'edited-frame': { type: 'string', default: '1' },
    align: { type: 'string', default: 'auto' }, 'local-warp': { type: 'string', default: 'auto' },
    'offset-x': { type: 'string', default: '0' }, 'offset-y': { type: 'string', default: '0' }, rotation: { type: 'string', default: '0' }, scale: { type: 'string', default: '1' },
    'color-strength': { type: 'string', default: '1' }, sensitivity: { type: 'string', default: '1' }, feather: { type: 'string', default: '2' },
    overwrite: { type: 'boolean', default: false }, quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) return { action: 'help' } as const;
  if (values.version) return { action: 'version' } as const;
  for (const name of ['original', 'edited', 'output'] as const) if (!values[name]?.trim()) throw new UsageError(`--${name} is required.`);
  const numeric = (name: string, min = -Infinity, max = Infinity, integer = false) => {
    const raw = values[name as keyof typeof values] as string, value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new UsageError(`--${name} must be ${integer ? 'an integer' : 'a finite number'}${min !== -Infinity ? ` >= ${min}` : ''}${max !== Infinity ? ` and <= ${max}` : ''}.`);
    }
    return value;
  };
  const scale = numeric('scale', 0);
  if (!scale) throw new UsageError('--scale must be greater than 0.');
  if (!['auto', 'none'].includes(values.align)) throw new UsageError('--align must be auto or none.');
  if (!['auto', 'off'].includes(values['local-warp'])) throw new UsageError('--local-warp must be auto or off.');
  const format = (values.format ?? extname(values.output!).slice(1)).toLowerCase();
  if (!['png', 'mask', 'psd'].includes(format) || (!values.format && format === 'mask')) throw new UsageError('Use --format png, mask, or psd; only .png and .psd can be inferred.');
  return {
    action: 'export' as const, original: resolve(values.original!), edited: resolve(values.edited!), output: resolve(values.output!), format: format as 'png' | 'mask' | 'psd',
    originalFrame: numeric('original-frame', 1, Infinity, true), editedFrame: numeric('edited-frame', 1, Infinity, true),
    align: values.align, localWarp: values['local-warp'], offsetX: numeric('offset-x'), offsetY: numeric('offset-y'), rotation: numeric('rotation'), scale,
    colorStrength: numeric('color-strength', 0, 1), sensitivity: numeric('sensitivity', 0.5, 1.6), feather: numeric('feather', 0), overwrite: values.overwrite, quiet: values.quiet,
  };
}

function progressReporter(quiet: boolean) {
  let stage = '', last = 0;
  return {
    update(value: Progress) {
      if (quiet) return;
      const now = performance.now(), changed = stage !== value.stage;
      if (!changed && (!process.stderr.isTTY || now - last < 100)) return;
      stage = value.stage; last = now;
      const percent = value.fraction === undefined ? '' : ` ${Math.round(value.fraction * 100)}%`;
      const text = translate('en', stage) + percent;
      process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${text}` : `${text}\n`);
    },
    finish() { if (!quiet && stage && process.stderr.isTTY) process.stderr.write('\n'); stage = ''; },
  };
}

async function saveOutput(path: string, bytes: Uint8Array, overwrite: boolean) {
  const directory = await mkdtemp(join(dirname(path), '.revia-'));
  try {
    const temporary = join(directory, 'output');
    await writeFile(temporary, bytes);
    if (overwrite) await rename(temporary, path);
    else await copyFile(temporary, path, constants.COPYFILE_EXCL);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function main(args: string[]): Promise<number> {
  let engine: Engine | undefined, reporter: ReturnType<typeof progressReporter> | undefined, cancelled = 0;
  const controller = new AbortController();
  const interrupt = () => { cancelled = 130; controller.abort(); };
  const terminate = () => { cancelled = 143; controller.abort(); };
  try {
    const options = parseOptions(args);
    if (options.action === 'help') { process.stdout.write(help); return 0; }
    if (options.action === 'version') { process.stdout.write(`${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}\n`); return 0; }
    const existing = await lstat(options.output).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing?.isDirectory()) throw new UsageError('The output path is a directory. Choose a file.');
    if (existing && !options.overwrite) throw new UsageError('The output file already exists. Use --overwrite to replace it.');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    reporter = progressReporter(options.quiet);
    const { Engine } = await import('./core/engine.ts'), { probeImage } = await import('./core/image.ts');
    engine = new Engine();
    for (const [slot, path, frame] of [['original', options.original, options.originalFrame], ['modified', options.edited, options.editedFrame]] as const) {
      reporter.update({ stage: `Loading ${slot === 'original' ? 'original' : 'edited'} image` });
      const bytes = await readFile(path, { signal: controller.signal }), probe = probeImage(bytes);
      if (frame > probe.frames) throw new UsageError(`${basename(path)} has ${probe.frames} frame(s); requested frame ${frame}.`);
      await engine.load(slot, bytes, basename(path), frame - 1);
      controller.signal.throwIfAborted();
    }
    if (options.format === 'psd' && !engine.info()!.psdSupported) throw new Error(engine.info()!.depth === 16 ? 'psdDepthUnsupported' : 'psdProfileUnsupported');
    engine.update({ colorStrength: options.colorStrength, feather: options.feather });
    let adjustment: Matrix | undefined;
    if (options.offsetX || options.offsetY || options.rotation || options.scale !== 1) {
      const cx = engine.original!.native.width / 2, cy = engine.original!.native.height / 2, radians = options.rotation * Math.PI / 180;
      const cosine = Math.cos(radians) / options.scale, sine = Math.sin(radians) / options.scale;
      // Resampling maps the final output back through the user's display transform.
      adjustment = [cosine, -sine, sine, cosine, cx - cosine * (cx + options.offsetX) - sine * (cy + options.offsetY), cy + sine * (cx + options.offsetX) - cosine * (cy + options.offsetY)];
      if (!adjustment.every(Number.isFinite)) throw new UsageError('The requested position transform exceeds the numeric range.');
    }
    await engine.analyze(reporter.update, controller.signal, options.align === 'none' ? [1, 0, 0, 1, 0, 0] : undefined, options.sensitivity, { adjustment, localWarp: options.align !== 'none' && options.localWarp === 'auto' });
    const bytes = await engine.export(options.format, reporter.update, controller.signal);
    controller.signal.throwIfAborted();
    reporter.update({ stage: 'Writing output' });
    await saveOutput(options.output, bytes, options.overwrite);
    reporter.finish();
    if (!options.quiet) process.stdout.write(`Saved ${options.output}\n`);
    return 0;
  } catch (error) {
    reporter?.finish();
    if (cancelled) { process.stderr.write('Cancelled.\n'); return cancelled; }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${translate('en', message)}\n`);
    const usage = error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS');
    if (usage) process.stderr.write('Run with --help to see usage and examples.\n');
    return usage ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    engine?.original?.color.dispose(); engine?.modified?.color.dispose();
  }
}
