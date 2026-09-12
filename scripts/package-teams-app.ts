/**
 * Builds the sideloadable Teams app package.
 *
 * Substitutes ${{TEAMS_APP_ID}} and ${{MICROSOFT_APP_ID}} from .env into
 * appPackage/manifest.json and zips it with the two icons.
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

function main(): void {
  const config = getConfig();

  if (!config.MICROSOFT_APP_ID) {
    throw new Error(
      'MICROSOFT_APP_ID is not set in .env. Create the bot registration first — see docs/teams-setup.md.',
    );
  }

  for (const icon of ['color.png', 'outline.png']) {
    if (!existsSync(`${SRC}/${icon}`)) {
      throw new Error(`${SRC}/${icon} is missing. Run: npx tsx scripts/make-icons.ts`);
    }
  }

  // The Teams app id is a separate GUID from the bot id. Reuse the configured
  // one when present, otherwise mint a stable-looking one and tell the user.
  const teamsAppId = process.env['TEAMS_APP_ID']?.trim() || randomUUID();
  if (!process.env['TEAMS_APP_ID']) {
    console.log(`No TEAMS_APP_ID set — generated ${teamsAppId}`);
    console.log('Add it to .env so re-packaging keeps the same app identity:');
    console.log(`  TEAMS_APP_ID=${teamsAppId}\n`);
  }

  const manifest = readFileSync(`${SRC}/manifest.json`, 'utf8')
    .replaceAll('${{TEAMS_APP_ID}}', teamsAppId)
    .replaceAll('${{MICROSOFT_APP_ID}}', config.MICROSOFT_APP_ID);

  // Fail loudly rather than shipping a package Teams will reject.
  const unresolved = /\$\{\{[^}]+\}\}/.exec(manifest);
  if (unresolved) throw new Error(`Unresolved placeholder in manifest: ${unresolved[0]}`);
  JSON.parse(manifest);

  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(`${BUILD}/manifest.json`, manifest);
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

  console.log(`\nBuilt ${ZIP}`);
  console.log(`  Teams app id: ${teamsAppId}`);
  console.log(`  Bot id:       ${config.MICROSOFT_APP_ID}`);
  console.log(
    '\nUpload it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app\n',
  );
}

try {
  main();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
