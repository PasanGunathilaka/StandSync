/**
 * Validates and builds the sideloadable Teams app package.
 *
 * Substitutes ${{TEAMS_APP_ID}} and ${{MICROSOFT_APP_ID}} from .env into
 * appPackage/manifest.json, checks it against the constraints Teams actually
 * enforces at upload, and zips it with the icons.
 *
 * Validating locally matters because a rejected upload gives a generic error in
 * the Teams UI; failing here says exactly which field is wrong.
 *
 * Usage: npm run teams:package
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';

const SRC = 'appPackage';
const BUILD = 'appPackage/build';
const ZIP = 'appPackage/build/standsync-teams.zip';

/** Supported manifest schema range, per the Teams manifest documentation. */
const MIN_SCHEMA = 1.19;
const MAX_SCHEMA = 1.3e1; // 1.30

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Manifest {
  manifestVersion?: string;
  version?: string;
  id?: string;
  packageName?: string;
  name?: { short?: string; full?: string };
  description?: { short?: string; full?: string };
  accentColor?: string;
  icons?: { color?: string; outline?: string };
  bots?: { botId?: string; scopes?: string[] }[];
}

/** Reads width/height straight out of a PNG IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${path} is not a valid PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function validate(manifest: Manifest): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  const schema = Number(manifest.manifestVersion);
  check(
    Number.isFinite(schema) && schema >= MIN_SCHEMA && schema <= MAX_SCHEMA,
    `manifestVersion ${manifest.manifestVersion} is outside the supported range ${MIN_SCHEMA}–1.30`,
  );

  check(GUID.test(manifest.id ?? ''), `id must be a GUID, got "${manifest.id}"`);
  check(
    /^\d+\.\d+\.\d+$/.test(manifest.version ?? ''),
    `version must be x.y.z, got "${manifest.version}"`,
  );
  check(
    /^[a-z0-9.]+$/i.test(manifest.packageName ?? ''),
    'packageName must be a reverse-domain identifier',
  );

  // Teams truncates or rejects these; the limits are documented per field.
  check((manifest.name?.short?.length ?? 0) <= 30, 'name.short exceeds 30 characters');
  check((manifest.name?.full?.length ?? 0) <= 100, 'name.full exceeds 100 characters');
  check(
    (manifest.description?.short?.length ?? 0) <= 80,
    `description.short exceeds 80 characters (${manifest.description?.short?.length})`,
  );
  check(
    (manifest.description?.full?.length ?? 0) <= 4000,
    'description.full exceeds 4000 characters',
  );
  check(!!manifest.description?.short, 'description.short is required');

  check(/^#[0-9a-f]{6}$/i.test(manifest.accentColor ?? ''), 'accentColor must be #rrggbb');

  const bot = manifest.bots?.[0];
  check(!!bot, 'a bots[] entry is required');
  check(GUID.test(bot?.botId ?? ''), `bots[0].botId must be a GUID, got "${bot?.botId}"`);
  check(
    (bot?.scopes?.length ?? 0) > 0 && (bot?.scopes ?? []).every((s) => s !== 'personal'),
    'bots[0].scopes must include team and/or groupChat for a channel bot',
  );

  // Icons: Teams requires these exact dimensions.
  for (const [kind, expected] of [
    ['color', 192],
    ['outline', 32],
  ] as const) {
    const file = manifest.icons?.[kind];
    if (!file) {
      problems.push(`icons.${kind} is required`);
      continue;
    }
    const path = `${SRC}/${file}`;
    if (!existsSync(path)) {
      problems.push(`${path} is missing — run: npm run teams:icons`);
      continue;
    }
    const { width, height } = pngSize(path);
    check(
      width === expected && height === expected,
      `${path} must be ${expected}x${expected}, is ${width}x${height}`,
    );
  }

  return problems;
}

function main(): void {
  const config = getConfig();

  if (!config.MICROSOFT_APP_ID) {
    throw new Error(
      'MICROSOFT_APP_ID is not set in .env. Create the bot registration first — see docs/teams-setup.md.',
    );
  }

  const teamsAppId = process.env['TEAMS_APP_ID']?.trim() || randomUUID();
  if (!process.env['TEAMS_APP_ID']) {
    console.log(`No TEAMS_APP_ID set — generated ${teamsAppId}`);
    console.log(
      `Add it to .env so repackaging keeps the same app identity:\n  TEAMS_APP_ID=${teamsAppId}\n`,
    );
  }

  const rendered = readFileSync(`${SRC}/manifest.json`, 'utf8')
    .replaceAll('${{TEAMS_APP_ID}}', teamsAppId)
    .replaceAll('${{MICROSOFT_APP_ID}}', config.MICROSOFT_APP_ID);

  const unresolved = /\$\{\{[^}]+\}\}/.exec(rendered);
  if (unresolved) throw new Error(`Unresolved placeholder in manifest: ${unresolved[0]}`);

  const manifest = JSON.parse(rendered) as Manifest;
  const problems = validate(manifest);
  if (problems.length) {
    throw new Error(
      `Manifest would be rejected by Teams — ${problems.length} problem(s):\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }

  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(`${BUILD}/manifest.json`, rendered);
  for (const icon of ['color.png', 'outline.png']) {
    writeFileSync(`${BUILD}/${icon}`, readFileSync(`${SRC}/${icon}`));
  }

  // Teams requires the manifest and icons at the ZIP root, not inside a folder.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${BUILD}/manifest.json','${BUILD}/color.png','${BUILD}/outline.png' -DestinationPath '${ZIP}' -Force`,
    ],
    { stdio: 'inherit' },
  );

  console.log(`\nManifest validated (schema ${manifest.manifestVersion}) and packaged.`);
  console.log(`  ZIP:          ${ZIP}`);
  console.log(`  Teams app id: ${teamsAppId}`);
  console.log(`  Bot id:       ${config.MICROSOFT_APP_ID}`);
  console.log('\nUpload in Teams: Apps → Manage your apps → Upload an app → Upload a custom app\n');
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
