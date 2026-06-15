// =============================================================================
// mint_on_demand.ts
// =============================================================================
// Mints a single NFT on Cardano (Preview or Mainnet) on demand.
// Images can be supplied as a local file path (uploaded to Blockfrost IPFS) or
// as a pre-existing IPFS CID.  A --batch mode accepts a JSON queue file so many
// NFTs can be minted in one run.
//
// Usage (single):
//   npx tsx "claude code/mint_on_demand.ts" \
//     --to   addr_test1... \
//     --name "DONADA Mint 001" \
//     --ipfs QmXxx...              # pre-uploaded CID
//   -- OR --
//     --image /path/to/image.jpg   # local file → auto-upload to IPFS
//
// Usage (batch):
//   npx tsx "claude code/mint_on_demand.ts" --batch mint_queue.json
//
//   mint_queue.json format:
//   [
//     { "to": "addr1...", "name": "DONADA Mint 001", "ipfsCid": "Qm..." },
//     { "to": "addr1...", "name": "DONADA Mint 002", "imagePath": "/abs/path/img.jpg" }
//   ]
//
// Environment variables:
//   REACT_APP_BlockFrost_API_KEY_Preview=previewXXX   (or Mainnet equivalent)
//   BLOCKFROST_IPFS_KEY=ipfsXXX
//   OWNER_SEED_PHRASE="word1 word2 ... word24"
//   NETWORK=Preview|Mainnet   (default: Preview)
//
// After the first mint the script prints the policy ID — copy it into
// MINT_POLICY_ID in MintPlatform.tsx.
// =============================================================================

import { Lucid, Blockfrost, fromText } from 'lucid-cardano';
import type { ProtocolParameters } from 'lucid-cardano';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK   = (process.env.NETWORK ?? 'Preview') as 'Preview' | 'Mainnet';
const CHAIN_KEY = NETWORK === 'Mainnet'
  ? (process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '')
  : (process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '');
const IPFS_KEY  = process.env.BLOCKFROST_IPFS_KEY ?? '';
const SEED      = (process.env.OWNER_SEED_PHRASE ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();

const CHAIN_URL = NETWORK === 'Mainnet'
  ? 'https://cardano-mainnet.blockfrost.io/api/v0'
  : 'https://cardano-preview.blockfrost.io/api/v0';
const IPFS_URL  = 'https://ipfs.blockfrost.io/api/v0';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MintItem {
  to:         string;
  name:       string;
  ipfsCid?:   string;
  imagePath?: string;
}

// ── Conway cost-model compat ──────────────────────────────────────────────────

class ConwayCompatBlockfrost extends Blockfrost {
  override async getProtocolParameters(): Promise<ProtocolParameters> {
    const params = await super.getProtocolParameters();
    const cm = params.costModels as Record<string, Record<string, number>> | undefined;
    if (!cm) return params;
    const patched = { ...cm };
    if (patched.PlutusV1) patched.PlutusV1 = Object.fromEntries(Object.entries(patched.PlutusV1).slice(0, 166));
    if (patched.PlutusV2) patched.PlutusV2 = Object.fromEntries(Object.entries(patched.PlutusV2).slice(0, 175));
    return { ...params, costModels: patched as ProtocolParameters['costModels'] };
  }
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function toJpeg(sourcePath: string): string {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return sourcePath;
  const outPath = join(tmpdir(), `donada_mint_${basename(sourcePath, ext)}.jpg`);
  execSync(`sips -s format jpeg "${sourcePath}" --out "${outPath}" --setProperty formatOptions 90`, { stdio: 'pipe' });
  return outPath;
}

// ── Blockfrost IPFS helpers ───────────────────────────────────────────────────

async function uploadToIpfs(imagePath: string): Promise<string> {
  if (!IPFS_KEY) throw new Error('BLOCKFROST_IPFS_KEY is not set.');
  const bytes = readFileSync(imagePath);
  const form  = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), basename(imagePath));
  const res = await fetch(`${IPFS_URL}/ipfs/add`, {
    method:  'POST',
    headers: { project_id: IPFS_KEY },
    body:    form,
  });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { ipfs_hash: string };
  return data.ipfs_hash;
}

async function pinCid(cid: string): Promise<void> {
  const res = await fetch(`${IPFS_URL}/ipfs/pin/add/${cid}`, {
    method:  'POST',
    headers: { project_id: IPFS_KEY },
  });
  if (!res.ok) throw new Error(`Pin failed for ${cid} (${res.status}): ${await res.text()}`);
}

// ── Mint a single NFT ─────────────────────────────────────────────────────────

async function mintOne(lucid: Lucid, item: MintItem, policyId: string, mintingPolicy: any): Promise<string> {
  const { to, name } = item;
  let cid = item.ipfsCid ?? '';

  if (!cid) {
    if (!item.imagePath) throw new Error(`Item "${name}" has neither ipfsCid nor imagePath.`);
    console.log(`  Uploading ${basename(item.imagePath)} to IPFS…`);
    const jpegPath = toJpeg(item.imagePath);
    cid = await uploadToIpfs(jpegPath);
    await pinCid(cid);
    console.log(`  Pinned → ipfs://${cid.slice(0, 20)}…`);
  }

  const assetUnit = policyId + fromText(name);

  const tx = await lucid.newTx()
    .mintAssets({ [assetUnit]: 1n })
    .attachMintingPolicy(mintingPolicy)
    .attachMetadata(721, {
      [policyId]: {
        [name]: {
          name,
          image:       `ipfs://${cid}`,
          mediaType:   'image/jpeg',
          description: 'DONADA Mint NFT',
        },
      },
    })
    .payToAddress(to, { [assetUnit]: 1n })
    .addSigner(await lucid.wallet.address())
    .complete();

  const signed = await tx.sign().complete();
  return signed.submit();
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs(): { items: MintItem[]; batch: boolean } {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };

  const batchFile = get('--batch');
  if (batchFile) {
    const items = JSON.parse(readFileSync(batchFile, 'utf-8')) as MintItem[];
    return { items, batch: true };
  }

  const to        = get('--to');
  const name      = get('--name');
  const ipfsCid   = get('--ipfs');
  const imagePath = get('--image');

  if (!to)   throw new Error('--to <recipient-address> is required.');
  if (!name) throw new Error('--name <nft-name> is required.');
  if (!ipfsCid && !imagePath) throw new Error('Either --ipfs <cid> or --image <path> is required.');

  return { items: [{ to, name, ipfsCid, imagePath }], batch: false };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SEED)      throw new Error('OWNER_SEED_PHRASE is not set.');
  if (!CHAIN_KEY) throw new Error(`Blockfrost chain API key for ${NETWORK} is not set.`);

  const { items } = parseArgs();
  if (items.length === 0) throw new Error('No items to mint.');

  console.log(`\nNetwork: ${NETWORK}`);
  console.log(`Minting ${items.length} NFT(s)…\n`);

  const lucid = await Lucid.new(new ConwayCompatBlockfrost(CHAIN_URL, CHAIN_KEY), NETWORK);
  lucid.selectWalletFromSeed(SEED);

  const walletAddress = await lucid.wallet.address();
  const { paymentCredential } = lucid.utils.getAddressDetails(walletAddress);
  if (!paymentCredential) throw new Error('No payment credential derived from seed.');

  const mintingPolicy = lucid.utils.nativeScriptFromJson({ type: 'sig', keyHash: paymentCredential.hash });
  const policyId      = lucid.utils.mintingPolicyToId(mintingPolicy);

  console.log(`Wallet:    ${walletAddress}`);
  console.log(`Policy ID: ${policyId}\n`);

  const txHashes: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}/${items.length}] Minting "${item.name}" → ${item.to.slice(0, 20)}…`);
    const txHash = await mintOne(lucid, item, policyId, mintingPolicy);
    txHashes.push(txHash);
    console.log(`  Tx: ${txHash}`);
    console.log(`  Explorer: https://${NETWORK === 'Preview' ? 'preview.' : ''}cardanoscan.io/transaction/${txHash}`);
    // Wait for confirmation between mints so UTxOs don't conflict.
    if (i < items.length - 1) {
      console.log('  Waiting for confirmation before next mint…');
      await lucid.awaitTx(txHash);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`Minted ${txHashes.length} NFT(s) successfully.`);
  console.log(`Policy ID: ${policyId}`);
  if (!process.env.MINT_POLICY_CONFIGURED) {
    console.log('\nIf this is your first mint, update MINT_POLICY_ID in MintPlatform.tsx:');
    console.log(`  const MINT_POLICY_ID = '${policyId}';`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
