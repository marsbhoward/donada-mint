// =============================================================================
// set_royalties.ts  — submits CIP-27 royalty metadata for the collection
// =============================================================================
// Run ONCE after your first mint to register royalties on-chain.
// Marketplaces (jpg.store, etc.) read label 777 from the policy's tx history.
//
// CIP-27 spec: https://github.com/cardano-foundation/CIPs/tree/master/CIP-0027
//
// Run:
//   npx tsx "claude code/set_royalties.ts"
//
// Env vars (same as mint_on_demand.ts):
//   REACT_APP_BlockFrost_API_KEY_Preview=previewXXX
//   OWNER_SEED_PHRASE="word1 word2 ... word24"
//   NETWORK=Preview|Mainnet   (default: Preview)
// =============================================================================

import { Lucid, Blockfrost } from 'lucid-cardano';
import type { ProtocolParameters } from 'lucid-cardano';

const NETWORK   = (process.env.NETWORK ?? 'Preview') as 'Preview' | 'Mainnet';
const CHAIN_KEY = NETWORK === 'Mainnet'
  ? (process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '')
  : (process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '');
const SEED = (process.env.OWNER_SEED_PHRASE ?? '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();

const CHAIN_URL = NETWORK === 'Mainnet'
  ? 'https://cardano-mainnet.blockfrost.io/api/v0'
  : 'https://cardano-preview.blockfrost.io/api/v0';

// ── Royalty config ────────────────────────────────────────────────────────────

// 10% royalty — expressed as a decimal string per CIP-27.
const ROYALTY_RATE = '0.1';

// Address that receives royalty payments.  Defaults to the project wallet
// (derived from the seed phrase), but can be any address.
const ROYALTY_ADDRESS_OVERRIDE = '';  // leave blank to use project wallet

// ── Conway compat ─────────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SEED)      throw new Error('OWNER_SEED_PHRASE is not set.');
  if (!CHAIN_KEY) throw new Error(`Blockfrost chain API key for ${NETWORK} is not set.`);

  const lucid = await Lucid.new(new ConwayCompatBlockfrost(CHAIN_URL, CHAIN_KEY), NETWORK);
  lucid.selectWalletFromSeed(SEED);

  const royaltyAddress = ROYALTY_ADDRESS_OVERRIDE || await lucid.wallet.address();

  console.log(`\nNetwork:         ${NETWORK}`);
  console.log(`Royalty rate:    ${Number(ROYALTY_RATE) * 100}%`);
  console.log(`Royalty address: ${royaltyAddress}`);

  // CIP-27: metadata label 777
  const tx = await lucid.newTx()
    .attachMetadata(777, {
      rate: ROYALTY_RATE,
      addr: royaltyAddress,
    })
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`Royalties set!  Tx: ${txHash}`);
  console.log(`Explorer: https://${NETWORK === 'Preview' ? 'preview.' : ''}cardanoscan.io/transaction/${txHash}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\nFailed:', err instanceof Error ? err.message : err); process.exit(1); });
