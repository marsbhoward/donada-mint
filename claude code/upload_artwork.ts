// =============================================================================
// upload_artwork.ts  — uploads a folder of images to Blockfrost IPFS
// =============================================================================
// Point this at a folder of artwork files (jpg/png/heic) sorted by name.
// Each file maps to a slot in collection.json in the same order.
// Prints a ready-to-paste JSON snippet with ipfsCid filled in for each slot.
//
// Run:
//   BLOCKFROST_IPFS_KEY=ipfsXXX npx tsx "claude code/upload_artwork.ts" ./artwork
//
// The artwork folder should contain files named however you like; they will be
// sorted alphabetically and matched 1-to-1 with collection.json slots.
// =============================================================================

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';

const IPFS_KEY = process.env.BLOCKFROST_IPFS_KEY ?? '';
const IPFS_URL = 'https://ipfs.blockfrost.io/api/v0';

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.gif', '.heic']);

function toJpeg(src: string): string {
  const ext = extname(src).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.gif') return src;
  const out = join(tmpdir(), `donada_${basename(src, ext)}.jpg`);
  execSync(`sips -s format jpeg "${src}" --out "${out}" --setProperty formatOptions 90`, { stdio: 'pipe' });
  return out;
}

async function upload(imagePath: string): Promise<string> {
  const bytes = readFileSync(imagePath);
  const ext   = extname(imagePath).toLowerCase();
  const mime  = (ext === '.png') ? 'image/png' : (ext === '.gif') ? 'image/gif' : 'image/jpeg';
  const form  = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), basename(imagePath));
  const res = await fetch(`${IPFS_URL}/ipfs/add`, { method: 'POST', headers: { project_id: IPFS_KEY }, body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { ipfs_hash: string }).ipfs_hash;
}

async function pin(cid: string): Promise<void> {
  const res = await fetch(`${IPFS_URL}/ipfs/pin/add/${cid}`, { method: 'POST', headers: { project_id: IPFS_KEY } });
  if (!res.ok) throw new Error(`Pin failed for ${cid}: ${await res.text()}`);
}

async function main() {
  if (!IPFS_KEY) throw new Error('BLOCKFROST_IPFS_KEY is not set.');

  const artworkDir = process.argv[2];
  if (!artworkDir) throw new Error('Usage: npx tsx upload_artwork.ts <artwork-folder>');

  const collectionPath = join(__dirname, '..', 'public', 'data', 'collection.json');
  const collection: Array<{ name: string; ipfsCid: string; [k: string]: unknown }>
    = JSON.parse(readFileSync(collectionPath, 'utf-8'));

  const files = readdirSync(artworkDir)
    .filter(f => SUPPORTED.has(extname(f).toLowerCase()))
    .sort()
    .map(f => join(artworkDir, f));

  if (files.length === 0) throw new Error(`No supported images found in ${artworkDir}`);
  if (files.length !== collection.length) {
    console.warn(`⚠  ${files.length} image(s) found, ${collection.length} slot(s) in collection.json — only uploading ${Math.min(files.length, collection.length)}.`);
  }

  const count = Math.min(files.length, collection.length);
  const updated = [...collection];

  console.log(`\nUploading ${count} image(s) to Blockfrost IPFS…\n`);

  for (let i = 0; i < count; i++) {
    const src  = files[i];
    const slot = collection[i];
    process.stdout.write(`  [${i + 1}/${count}] ${basename(src)} → "${slot.name}"… `);
    const jpeg = toJpeg(src);
    const cid  = await upload(jpeg);
    await pin(cid);
    updated[i] = { ...slot, ipfsCid: cid };
    console.log(`ipfs://${cid.slice(0, 20)}…`);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('Updated collection.json (copy this into public/data/collection.json):\n');
  console.log(JSON.stringify(updated, null, 2));
  console.log('──────────────────────────────────────────────────────────────\n');
}

main().catch(err => { console.error('\nFailed:', err instanceof Error ? err.message : err); process.exit(1); });
