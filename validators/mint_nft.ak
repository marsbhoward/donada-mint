// =============================================================================
// mint_nft.ak
// =============================================================================
// Plutus V2 minting policy for the DONADA on-demand mint platform.
//
// Any user can mint exactly one NFT per transaction provided they pay the
// mint price to the project wallet.  No admin signature is required.
//
// Setup steps:
//   1. Derive your project wallet payment key hash (28-byte hex) and replace
//      the placeholder below.  From your terminal:
//
//        npx tsx "claude code/derive_pkh.ts"
//
//      Or paste your bech32 address into https://tool.cardanoscan.io/ → "Address"
//      and copy the "Payment part (hex)".
//
//   2. Adjust MINT_PRICE if needed (default: 5 ADA = 5_000_000 lovelace).
//
//   3. Run `aiken build` from the donada-mint directory.
//
//   4. Copy build/plutus.json → public/data/plutus.json
//
//   5. The policy ID is the validator hash printed by `aiken build`.
//      Paste it into MINT_POLICY_ID in MintPlatform.tsx (optional — the UI
//      derives it dynamically from plutus.json if left blank).
// =============================================================================

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{VerificationKey}
use cardano/assets
use cardano/transaction.{Output, Transaction}

// ── Parameters ────────────────────────────────────────────────────────────────

/// Mint price in lovelace.  498 ADA — user's total out-of-pocket is ~500 ADA
/// once the ~0.5 ADA tx fee and ~1.5 ADA min-ADA deposit are included.
const mint_price: Int = 498_000_000

/// Payment key hash of the project wallet.
/// Derived from addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388
const project_wallet_pkh: ByteArray =
  #"8fdf18774dcf5a71cf0330cb7ffadd42a9ac99322e256561b5501b4f"

// ── Validator ─────────────────────────────────────────────────────────────────

validator mint_nft {
  /// Minting redeemer is unused — the policy only inspects the transaction.
  mint(_redeemer: Data, policy_id: ByteArray, tx: Transaction) {
    let policy_minted = assets.tokens(tx.mint, policy_id)
    let burns = dict.filter(policy_minted, fn(_, qty) { qty < 0 })
    let mints = dict.filter(policy_minted, fn(_, qty) { qty > 0 })

    if dict.size(burns) > 0 && dict.size(mints) == 0 {
      // ── Burn path: allow project wallet to correct duplicates ───────────────
      list.any(tx.extra_signatories, fn(pkh) { pkh == project_wallet_pkh })
    } else {
      // ── Mint path ───────────────────────────────────────────────────────────

      // Rule 1: 1–5 unique tokens minted, each with quantity exactly 1
      let token_count = dict.size(mints)
      let each_quantity_is_one =
        mints
          |> dict.values()
          |> list.all(fn(qty) { qty == 1 })

      // Rule 2: mint price × quantity paid to project wallet
      let total_to_project =
        list.foldl(
          tx.outputs,
          0,
          fn(output: Output, acc: Int) -> Int {
            when output.address.payment_credential is {
              VerificationKey(pkh) ->
                if pkh == project_wallet_pkh {
                  acc + assets.lovelace_of(output.value)
                } else {
                  acc
                }
              _ -> acc
            }
          },
        )

      token_count >= 1 && token_count <= 5 && each_quantity_is_one && total_to_project >= mint_price * token_count
    }
  }

  else(_) {
    fail
  }
}
