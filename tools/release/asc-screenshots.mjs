// Upload a screenshot set to App Store Connect.
//
// Usage: node tools/release/asc-screenshots.mjs <directory>
//
// The directory holds `phone-*.png` (APP_IPHONE_67) and `ipad-*.png`
// (APP_IPAD_PRO_3GEN_129), named so they sort into the order they should
// appear. Every locale on the current version gets the same set, which is what
// the listing did before: the app's own screens carry three languages, so the
// art does not need translating.
//
// Apple's upload is four steps per image, and the last one is the one that
// matters: an asset that is never marked uploaded stays in a half-created
// state and the version cannot be submitted.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { asc, ascConfig } from './asc.mjs';

// ascConfig is the reader, not the config: wait-build.mjs calls it the same way.
const APP_ID = ascConfig().appId;

async function ascJson(method, path, body) {
  const response = await asc(method, path, body);
  if (response.status >= 300) {
    throw new Error(`${method} ${path} -> ${response.status}: ${(response.text || '').slice(0, 300)}`);
  }
  return response.json;
}

/** Clear a set so a re-run replaces rather than appends. */
async function emptySet(setId) {
  const existing = await ascJson('GET', `/appScreenshotSets/${setId}/appScreenshots?limit=20`);
  for (const shot of existing.data ?? []) {
    await asc('DELETE', `/appScreenshots/${shot.id}`);
  }
}

async function uploadOne(setId, file) {
  const bytes = readFileSync(file);
  const fileName = basename(file);

  // 1. Reserve. Apple answers with the exact requests to make.
  const reserved = await ascJson('POST', '/appScreenshots', {
    data: {
      type: 'appScreenshots',
      attributes: { fileSize: bytes.length, fileName },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
    },
  });
  const id = reserved.data.id;

  // 2. Send the bytes exactly as each operation describes.
  for (const operation of reserved.data.attributes.uploadOperations ?? []) {
    const headers = Object.fromEntries((operation.requestHeaders ?? []).map((h) => [h.name, h.value]));
    const slice = bytes.subarray(operation.offset, operation.offset + operation.length);
    const put = await fetch(operation.url, { method: operation.method, headers, body: slice });
    if (!put.ok) throw new Error(`upload of ${fileName} failed: ${put.status}`);
  }

  // 3. Commit with the checksum, which is what flips it out of the half-created
  //    state. Skipping this leaves an asset that blocks submission.
  await ascJson('PATCH', `/appScreenshots/${id}`, {
    data: {
      type: 'appScreenshots',
      id,
      attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
    },
  });
  return id;
}

export async function uploadScreenshots(directory, log = console.log) {
  const files = readdirSync(directory).filter((name) => name.endsWith('.png'));
  const groups = {
    APP_IPHONE_67: files.filter((n) => n.startsWith('phone-')).sort(),
    APP_IPAD_PRO_3GEN_129: files.filter((n) => n.startsWith('ipad-')).sort(),
  };

  const versions = await ascJson('GET', `/apps/${APP_ID}/appStoreVersions?limit=1`);
  const versionId = versions.data[0].id;
  const locales = await ascJson('GET', `/appStoreVersions/${versionId}/appStoreVersionLocalizations`);

  for (const localization of locales.data ?? []) {
    const locale = localization.attributes.locale;
    const sets = await ascJson('GET', `/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`);
    for (const [displayType, names] of Object.entries(groups)) {
      if (names.length === 0) continue;
      let set = (sets.data ?? []).find((s) => s.attributes.screenshotDisplayType === displayType);
      if (!set) {
        const made = await ascJson('POST', '/appScreenshotSets', {
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: displayType },
            relationships: {
              appStoreVersionLocalization: {
                data: { type: 'appStoreVersionLocalizations', id: localization.id },
              },
            },
          },
        });
        set = made.data;
      } else {
        await emptySet(set.id);
      }
      for (const name of names) await uploadOne(set.id, join(directory, name));
      log(`  ${locale.padEnd(6)} ${displayType.padEnd(24)} ${names.length} uploaded`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: asc-screenshots.mjs <directory>');
  await uploadScreenshots(directory);
}
