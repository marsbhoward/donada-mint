// =============================================================================
// derive_pkh.ts  — prints the payment key hash for a bech32 Cardano address
// =============================================================================
// Run:  npx tsx "claude code/derive_pkh.ts"
// =============================================================================

import { Lucid, Blockfrost } from 'lucid-cardano';

const ADDRESS =
  process.argv[2] ??
  'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

async function main() {
  // Lucid.new() requires a provider, but getAddressDetails is pure — any key works.
  const lucid = await Lucid.new(new Blockfrost('https://cardano-preview.blockfrost.io/api/v0', 'dummy'), 'Preview');
  const { paymentCredential } = lucid.utils.getAddressDetails(ADDRESS);

  if (!paymentCredential) {
    console.error('No payment credential found in address:', ADDRESS);
    process.exit(1);
  }

  console.log('\nAddress:  ', ADDRESS);
  console.log('PKH (hex):', paymentCredential.hash);
  console.log('\nPaste this into validators/mint_nft.ak:');
  console.log(`  const project_wallet_pkh: ByteArray = #"${paymentCredential.hash}"\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
