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
import AjvModule from 'ajv-draft-04';
import addFormatsModule from 'ajv-formats';
import { getConfig } from '../src/config.js';

/**
 * The Teams manifest schema is authored against JSON Schema draft-04, so the
 * draft-04 build of ajv is required. ajv is CommonJS, so under nodenext its
 * default import types as the module namespace even though Node hands back the
 * constructor at runtime. These are the minimal shapes this script uses.
 */
interface SchemaError {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: { additionalProperty?: string };
}
interface CompiledSchema {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}
interface AjvInstance {
  compile(schema: unknown): CompiledSchema;
}
type AjvConstructor = new (opts?: { allErrors?: boolean; strict?: boolean }) => AjvInstance;

const AjvDraft04 = AjvModule as unknown as AjvConstructor;
const addFormats = addFormatsModule as unknown as (ajv: AjvInstance) => void;

const SRC = 'appPackage';
const BUILD = 'appPackage/build';
/** The three files that become the ZIP root. Kept in its own folder so the
 *  archive is never written into the directory being archived. */
const STAGE = 'appPackage/build/pkg';
const ZIP = 'appPackage/build/standsync-teams.zip';

/** Supported manifest schema range, per the Teams manifest documentation. */
const MIN_SCHEMA = 1.19;
const MAX_SCHEMA = 1.3e1; // 1.30

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Manifest {
  manifestVersion?: string;
  version?: string;
  id?: string;
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

/**
 * Validates the manifest against the real Microsoft schema for the version it
 * declares — the same document Teams validates against at upload.
 *
 * The schema is vendored (appPackage/schema/) rather than fetched, so packaging
 * works offline and the result is reproducible. `additionalProperties` is false
 * throughout, so this is what catches a property that is merely obsolete rather
 * than malformed — `packageName`, for instance, was valid in older manifests and
 * is rejected outright from 1.19 onward.
 */
function validateAgainstSchema(manifest: Manifest): string[] {
  const declared = manifest.manifestVersion ?? '';
  const schemaPath = `${SRC}/schema/MicrosoftTeams.v${declared}.schema.json`;

  if (!existsSync(schemaPath)) {
    throw new Error(
      `No vendored schema for manifestVersion ${declared} (expected ${schemaPath}).\n` +
        `Download it from https://developer.microsoft.com/json-schemas/teams/v${declared}/MicrosoftTeams.schema.json`,
    );
  }

  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  addFormats(ajv);

  const validateFn = ajv.compile(schema);
  if (validateFn(manifest)) return [];

  return (validateFn.errors ?? []).map((e) => {
    const where = e.instancePath || '(root)';
    const extra =
      e.keyword === 'additionalProperties'
        ? ` — "${String((e.params as { additionalProperty?: string }).additionalProperty)}" is not defined in schema ${declared}`
        : '';
    return `${where}: ${e.message ?? 'invalid'}${extra}`;
  });
}

/**
 * Reopens the finished ZIP and asserts the layout Teams requires: exactly the
 * three files, at the root, with no directory component. Catching this here
 * turns a confusing "ManifestFileNotFound" in the Teams UI into a local failure.
 */
function verifyZipLayout(): void {
  const required = ['manifest.json', 'color.png', 'outline.png'];
  const buf = readFileSync(ZIP);
  const names: string[] = [];

  // Walk local file headers; each begins with the PK\003\004 signature.
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const flags = buf.readUInt16LE(off + 6);
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const elen = buf.readUInt16LE(off + 28);
    names.push(buf.subarray(off + 30, off + 30 + nlen).toString('utf8'));
    // Bit 3 means sizes live in a trailing descriptor, so the walk cannot continue.
    if (flags & 0x08) {
      throw new Error(
        'ZIP uses streaming data descriptors, which Teams may reject. Rebuild with ZipFile.',
      );
    }
    off += 30 + nlen + elen + csize;
  }

  const problems: string[] = [];
  for (const name of names) {
    if (name.includes('/') || name.includes('\\')) {
      problems.push(`"${name}" is nested in a folder — Teams needs it at the root`);
    }
  }
  for (const want of required) {
    if (!names.includes(want)) problems.push(`${want} is missing from the ZIP root`);
  }

  if (problems.length) {
    throw new Error(
      `ZIP layout is wrong — Teams would report ManifestFileNotFound:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}\n  entries found: ${names.join(', ') || '(none)'}`,
    );
  }

  console.log(`ZIP layout verified — ${names.length} entries at root: ${names.join(', ')}`);
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

  // Two layers: the official schema (authoritative), then our own checks for
  // things the schema cannot see, such as the icons' pixel dimensions.
  const problems = [...validateAgainstSchema(manifest), ...validate(manifest)];
  if (problems.length) {
    throw new Error(
      `Manifest would be rejected by Teams — ${problems.length} problem(s):\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }
  console.log(`Schema validation passed against vendored v${manifest.manifestVersion} schema.`);

  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(STAGE, { recursive: true });
  writeFileSync(`${STAGE}/manifest.json`, rendered);
  for (const icon of ['color.png', 'outline.png']) {
    writeFileSync(`${STAGE}/${icon}`, readFileSync(`${SRC}/${icon}`));
  }

  // Teams requires manifest.json and both icons at the ZIP ROOT. A top-level
  // folder is the usual cause of "ManifestFileNotFound" at upload.
  //
  // Built with .NET's ZipFile rather than Compress-Archive: across PowerShell
  // versions Compress-Archive has written entry names with backslash separators
  // and streaming data descriptors, both of which strict unzip implementations
  // reject. CreateFromDirectory with includeBaseDirectory=false puts the three
  // files at the root with conventional headers.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path '${STAGE}').Path, ` +
        `(Join-Path (Resolve-Path '${BUILD}').Path 'standsync-teams.zip'), ` +
        '[System.IO.Compression.CompressionLevel]::Optimal, $false)',
    ],
    { stdio: 'inherit' },
  );

  verifyZipLayout();

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
