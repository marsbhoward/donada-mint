const BLOCKFROST_URLS = {
  Mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  Preview: 'https://cardano-preview.blockfrost.io/api/v0',
};

export function utf8ToHex(str) {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToUtf8(hex) {
  return new TextDecoder().decode(
    Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)))
  );
}

export async function fetchNftMetadata(policyId, assetName, network = 'Preview') {
  const base   = BLOCKFROST_URLS[network] ?? BLOCKFROST_URLS.Preview;
  const apiKey = network === 'Mainnet'
    ? process.env.REACT_APP_BlockFrost_API_KEY_Mainnet
    : process.env.REACT_APP_BlockFrost_API_KEY_Preview;

  try {
    const assetNameHex = utf8ToHex(assetName);
    const assetId = `${policyId}${assetNameHex}`;

    const res = await fetch(`${base}/assets/${assetId}`, {
      headers: { project_id: apiKey },
    });

    if (!res.ok) throw new Error('Blockfrost asset fetch failed');

    const data = await res.json();
    const onchain = data.onchain_metadata || {};
    const rawImage = onchain.image;
    const image = rawImage
      ? (Array.isArray(rawImage) ? rawImage.join('') : String(rawImage))
          .replace('ipfs://', 'https://ipfs.io/ipfs/')
      : null;

    return { policyId, assetName, assetNameHex, assetId, name: onchain.name || hexToUtf8(assetNameHex), image, metadata: onchain };
  } catch (err) {
    console.error('fetchNftMetadata error:', err);
    return { policyId, assetName, assetNameHex: null, assetId: null, name: assetName, image: null, metadata: null, error: true };
  }
}
