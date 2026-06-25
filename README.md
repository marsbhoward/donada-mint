# DONADA Mint

On-demand NFT minting platform on Cardano. Users connect a wallet and mint 1–5 random NFTs per transaction. Built with React, Lucid, and an Aiken Plutus V2 minting policy.

## Stack

| Layer | Tool |
|---|---|
| Frontend | React + TypeScript (craco) |
| Cardano tx | Lucid |
| Tx submission / script eval | Blockfrost |
| Read-only queries | Koios (no API key required) |
| Minting policy | Aiken (Plutus V2) |
| Image storage | IPFS via Blockfrost |

## Setup

### 1. Configure the validator

Open [validators/mint_nft.ak](validators/mint_nft.ak) and set:

```
const project_wallet_pkh: ByteArray = #"<your 28-byte payment key hash>"
const mint_price: Int = <price in lovelace>
```

To derive your payment key hash from a bech32 address:
```bash
npx tsx "claude code/derive_pkh.ts"
```
Or paste your address into [CardanoScan](https://cardanoscan.io) → Address → Payment part (hex).

### 2. Build the validator

```bash
aiken build
cp plutus.json public/data/plutus.json
```

The policy ID is derived at runtime from `public/data/plutus.json`. The app will error on load if this file is missing.

### 3. Configure the frontend

In [src/containers/MintPlatform.tsx](src/containers/MintPlatform.tsx):

```ts
const MINT_PRICE_LOVELACE = <price in lovelace>n   // must match mint_nft.ak
const PROJECT_WALLET_ADDRESS = '<your bech32 address>'
```

> **Important:** `MINT_PRICE_LOVELACE` in the frontend and `mint_price` in the validator must always be kept in sync. The validator enforces the price on-chain — if the values diverge, transactions will fail validation.

### 4. Add collection metadata

Edit [public/data/collection.json](public/data/collection.json). Each entry requires a non-empty `ipfsCid` to be available for minting:

```json
{
  "name": "Donada 0001",
  "ipfsCid": "QmZZFNde4EEBKcSDvjDjgRbdm71KEdax7dsvTjdQcKGx9n",
  "mediaType": "image/jpeg",
  "description": "Donada01 NFT collection",
  "traits": {
    "Collection": "Donada0001",
    "Type": "Rainbow",
    "Artist": "Luna"
  }
}
```

Upload images to IPFS via Blockfrost:
```bash
curl -X POST "https://ipfs.blockfrost.io/api/v0/ipfs/add" \
  -H "project_id: <ipfs_project_id>" \
  -F "file=@image.jpg"

# Then pin it
curl -X POST "https://ipfs.blockfrost.io/api/v0/ipfs/pin/add/<CID>" \
  -H "project_id: <ipfs_project_id>"
```

### 5. Run

```bash
npm install
npm start
```

## How minting works

1. User connects a Cardano wallet (Nami, Eternl, etc.)
2. User selects quantity (1–5) and clicks Mint
3. A single transaction is built that:
   - Mints all selected tokens under the policy
   - Attaches CIP-25 metadata for each token
   - Pays `mint_price × quantity` lovelace to the project wallet
4. The Plutus validator enforces on-chain that quantity is 1–5, each token quantity is exactly 1, and the correct total payment is included
5. User signs and submits via their wallet

Slots are assigned cryptographically at random from the remaining unminted pool. If the requested quantity is no longer fully available at submission time, the quantity is silently reduced and the user is notified.

## Known limitation — duplicate minting

The on-chain validator enforces payment and quantity rules but **cannot prevent the same token name from being minted twice** across separate transactions. Plutus validators only see the current transaction, not blockchain history, so there is no native way to check whether a given name already exists on-chain.

The client-side `fetchMintedNames` re-fetch immediately before each mint provides strong protection in practice, but a race condition between two simultaneous mints is theoretically possible.

The correct on-chain fix requires a **UTxO-consumption pattern**: pre-create one UTxO per slot and require it to be spent during the corresponding mint (a UTxO can only be spent once, guaranteeing uniqueness). This needs a companion spending validator alongside the minting policy — a significant contract rewrite. The practical alternative for high-traffic launches is a **backend minting service** that locks slots atomically before building the transaction.

## Networks

Switch between Preview testnet and Mainnet via the Admin panel (visible when connected with the project wallet address). Blockfrost project IDs are configured per-network in the source.
