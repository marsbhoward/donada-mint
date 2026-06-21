/// <reference types="node" />
import React, { useState, useEffect, useRef, useMemo } from 'react';
import TxConfirmModal from '../components/TxConfirmModal';
import DisclaimerModal from '../components/DisclaimerModal';
import {
  Lucid, type LucidEvolution, Blockfrost,
  fromText, fromHex, toHex,
  Data, Constr,
  applyDoubleCborEncoding, mintingPolicyToId,
  makeWalletFromAPI,
  type Script, type WalletApi,
} from '@lucid-evolution/lucid';

// ── Constants ─────────────────────────────────────────────────────────────────

// Mint price paid to the project wallet per NFT (must match mint_nft.ak).
const MINT_PRICE_LOVELACE  = 498_000_000n;  // 498 ADA — total out-of-pocket ~500 ADA after tx fee + min-ADA deposit
const JACKPOT_PERCENT      = 0.20;           // 20% of total mint revenue

// Project wallet — receives the mint price.
const PROJECT_WALLET_ADDRESS =
  'addr_test1qz8a7xrhfh845uw0qvcvkll6m4p2ntyexghz2etpk4gpknm8x3f9dwp37v9xese67nv0nnczvkzqh60z30n6v9cw2fasq4l388';

const COLLECTION_NAME = 'DONADA Mint';

// Optional: hardcode the policy ID to skip plutus.json loading (useful for frontend testing).
// Leave blank ('') to derive it dynamically from public/data/plutus.json at runtime.
const MINT_POLICY_ID = ''; // set to override plutus.json derivation (e.g. for testing)

// Cache minted names in sessionStorage with a TTL so simultaneous page loads
// don't each fire their own Koios requests.
const MINTED_CACHE_TTL_MS = 30_000; // 30 s

function getMintedCache(policyId: string): Set<string> | null {
  try {
    const raw = sessionStorage.getItem(`minted_${policyId}`);
    if (!raw) return null;
    const { ts, names } = JSON.parse(raw) as { ts: number; names: string[] };
    if (Date.now() - ts > MINTED_CACHE_TTL_MS) return null;
    return new Set(names);
  } catch { return null; }
}

function setMintedCache(policyId: string, names: Set<string>): void {
  try {
    sessionStorage.setItem(`minted_${policyId}`, JSON.stringify({ ts: Date.now(), names: [...names] }));
  } catch {}
}

async function fetchMintedNames(policyId: string, network: Network): Promise<Set<string>> {
  const cached = getMintedCache(policyId);
  if (cached) return cached;

  const { url, apiKey } = blockfrostConfig(network);
  const names = new Set<string>();
  let page = 1;
  const COUNT = 100;

  while (true) {
    const res = await fetch(
      `${url}/assets/policy/${policyId}?count=${COUNT}&page=${page}`,
      { headers: { project_id: apiKey } },
    );
    if (res.status === 404) break; // policy not yet indexed (nothing minted)
    if (!res.ok) break;
    const data: Array<{ asset: string }> = await res.json();
    for (const { asset } of data) {
      const hexName = asset.slice(policyId.length);
      try {
        names.add(new TextDecoder().decode(Uint8Array.from(
          hexName.match(/.{1,2}/g)!.map(b => parseInt(b, 16))
        )));
      } catch {}
    }
    if (data.length < COUNT) break;
    page++;
  }

  setMintedCache(policyId, names);
  return names;
}

// Retry wrapper — backs off on 429/503 so a throttled response doesn't surface
// to the user as an error.
async function withRetry<T>(fn: () => Promise<T>, retries = 4, baseDelayMs = 800): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const status = (err as any)?.status ?? (err as any)?.code;
      const retriable = status === 429 || status === 503 || status === 'ETIMEDOUT';
      if (!retriable || attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Network = 'Mainnet' | 'Preview';

interface WalletInfo { key: string; name: string; icon: string | null; }
interface ConnectedWalletState { name: string; api: unknown; }

interface CollectionSlot {
  name:        string;
  ipfsCid:     string;
  mediaType?:  string;
  description: string;
  traits?:     Record<string, string>;
}

// ── Blockfrost compat ─────────────────────────────────────────────────────────

function blockfrostConfig(network: Network) {
  return network === 'Preview'
    ? { url: 'https://cardano-preview.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Preview ?? '' }
    : { url: 'https://cardano-mainnet.blockfrost.io/api/v0', apiKey: process.env.REACT_APP_BlockFrost_API_KEY_Mainnet ?? '' };
}

let _lucidCacheNetwork: Network | null = null;
let _lucidCachePromise: Promise<LucidEvolution> | null = null;

async function initLucid(network: Network): Promise<LucidEvolution> {
  if (_lucidCacheNetwork === network && _lucidCachePromise) return _lucidCachePromise;
  _lucidCacheNetwork = network;
  const { url, apiKey } = blockfrostConfig(network);
  _lucidCachePromise = Lucid(new Blockfrost(url, apiKey), network);
  return _lucidCachePromise;
}

// ── Validator loader ──────────────────────────────────────────────────────────

interface MintPolicy { policyId: string; compiledCode: string; }
let _policyCache: MintPolicy | null = null;

async function loadMintPolicy(): Promise<MintPolicy> {
  if (_policyCache) return _policyCache;

  if (MINT_POLICY_ID) {
    _policyCache = { policyId: MINT_POLICY_ID, compiledCode: '' };
    return _policyCache;
  }

  const resp = await fetch('/data/plutus.json');
  if (!resp.ok) throw new Error('Could not load /data/plutus.json — run `aiken build` and copy the file to public/data/.');
  const blueprint = await resp.json();
  const validator = blueprint.validators?.find((v: { title: string }) => v.title === 'mint_nft.mint_nft.mint');
  if (!validator) throw new Error('mint_nft validator not found in plutus.json');

  const script   = applyDoubleCborEncoding(validator.compiledCode);
  // Use the hash pre-computed by aiken (correct PlutusV3 hash), fall back to deriving it
  const policyId = validator.hash ?? mintingPolicyToId({ type: 'PlutusV3', script });

  _policyCache = { policyId, compiledCode: script };
  return _policyCache;
}

function selectWallet(lucid: LucidEvolution, cip30Api: unknown): void {
  lucid.selectWallet.fromAPI(cip30Api as WalletApi);
}

// ── Wallet brand colours ──────────────────────────────────────────────────────

const WALLET_BRAND_COLORS: Record<string, string> = {
  eternl: '#1d2d50', lace: '#7b4dff', nami: '#349ea3', yoroi: '#1a44b7',
  flint: '#ea580c', typhon: '#5b4ee9', vespr: '#3b82f6', gerowallet: '#10b981',
  nufi: '#4f46e5', begin: '#06b6d4',
};

const WALLET_DOWNLOADS: { key: string; name: string; url: string }[] = [
  { key: 'eternl',     name: 'Eternl',     url: 'https://eternl.io' },
  { key: 'lace',       name: 'Lace',       url: 'https://www.lace.io' },
  { key: 'vespr',      name: 'Vespr',      url: 'https://vespr.xyz' },
  { key: 'nami',       name: 'Nami',       url: 'https://namiwallet.io' },
  { key: 'flint',      name: 'Flint',      url: 'https://flint-wallet.com' },
  { key: 'typhon',     name: 'Typhon',     url: 'https://typhonwallet.io' },
  { key: 'yoroi',      name: 'Yoroi',      url: 'https://yoroi-wallet.com' },
  { key: 'gerowallet', name: 'GeroWallet', url: 'https://gerowallet.io' },
  { key: 'nufi',       name: 'NuFi',       url: 'https://nu.fi' },
  { key: 'begin',      name: 'Begin',      url: 'https://begin.is' },
];

function getAvailableWallets(): WalletInfo[] {
  const cardano = (window as any).cardano;
  if (!cardano) return [];
  return Object.entries(cardano as Record<string, { enable?: unknown; name?: string; icon?: string }>)
    .filter(([, w]) => w && typeof w.enable === 'function')
    .map(([key, w]) => ({ key, name: w.name || key, icon: w.icon || null }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MintPlatform() {
  const [network, setNetwork] = useState<Network>('Preview');

  // Wallet
  const [wallets, setWallets]                     = useState<WalletInfo[]>([]);
  const [connectedWallet, setConnectedWallet]     = useState<ConnectedWalletState | null>(null);
  const connectedWalletRef = useRef<ConnectedWalletState | null>(null);
  const carouselTouchRef  = useRef({ startX: 0 });
  const [fullWalletAddress, setFullWalletAddress] = useState<string | null>(null);

  // Disclaimer
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(
    () => sessionStorage.getItem('disclaimer_accepted') === 'true'
  );
  const [disclaimerDeclined, setDisclaimerDeclined] = useState(false);
  const handleAcceptDisclaimer = () => {
    sessionStorage.setItem('disclaimer_accepted', 'true');
    setDisclaimerAccepted(true);
  };
  const handleDeclineDisclaimer = () => {
    setDisclaimerDeclined(true);
  };

  // Theme — dark by default, persisted in localStorage, synced to data-theme on <html>
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const stored = localStorage.getItem('theme');
    return stored ? stored === 'dark' : true;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);
  const [isDimming, setIsDimming]     = useState(false);
  const [signBtnAnim, setSignBtnAnim] = useState<'idle' | 'out' | 'in'>('idle');

  // Collection state
  const [collection, setCollection]           = useState<CollectionSlot[]>([]);
  const [mintedNames, setMintedNames]         = useState<Set<string>>(new Set());
  const [featuredNftImage, setFeaturedNftImage] = useState<string | null>(
    'https://ipfs.blockfrost.dev/ipfs/QmYhkbGmep9XCJEMQDeLGPRL9h9VUvUbDPWBjFz9A37eHY'
  );
  const [policyId, setPolicyId]               = useState<string | null>(null);
  const [statsLoading, setStatsLoading]       = useState(true);


  // Mint flow
  const [isMinting, setIsMinting]       = useState(false);
  const [mintError, setMintError]       = useState<string | null>(null);
  const [mintWarning, setMintWarning]   = useState<string | null>(null);
  const [mintedSlots, setMintedSlots]   = useState<CollectionSlot[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [mintQuantity, setMintQuantity] = useState(1);
  const [txConfirm, setTxConfirm]       = useState<{ title: string; txHash: string } | null>(null);
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  const [walletNotice, setWalletNotice]   = useState<string | null>(null);
  const [showNoWalletModal, setShowNoWalletModal] = useState(false);

  const raiseWalletNotice = (err: unknown) => {
    const code = (err as any)?.code;
    if (code === -3) setWalletNotice('locked');
    else if (code === -2) setWalletNotice('disconnected');
  };

  // Admin
  const isAdmin = fullWalletAddress === PROJECT_WALLET_ADDRESS;
  const [duplicates, setDuplicates]             = useState<Array<{ name: string; mintCount: number }>>([]);
  const [checkingDups, setCheckingDups]         = useState(false);
  const [dupError, setDupError]                 = useState<string | null>(null);
  const [burningSlot, setBurningSlot]           = useState<string | null>(null);
  const [burnResults, setBurnResults]           = useState<Record<string, string>>({});
  const [priceExpanded, setPriceExpanded]       = useState(false);
  const [jackpotExpanded, setJackpotExpanded]   = useState(false);

  // Launch countdown — 2026-06-11 7:20 PM CDT (UTC-5) = 2026-06-12T00:20:00Z
  const LAUNCH_DATE = new Date('2026-06-12T00:20:00Z');
  const [countdown, setCountdown] = useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(() => {
    const diff = LAUNCH_DATE.getTime() - Date.now();
    if (diff <= 0) return null;
    const s = Math.floor(diff / 1000);
    return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
  });
  const [countdownFading, setCountdownFading] = useState(false);

  useEffect(() => {
    const diff = LAUNCH_DATE.getTime() - Date.now();
    if (diff <= 0) { setCountdown(null); return; }
    const interval = setInterval(() => {
      const d = LAUNCH_DATE.getTime() - Date.now();
      if (d <= 0) {
        clearInterval(interval);
        setCountdownFading(true);
        setTimeout(() => { setCountdown(null); setCountdownFading(false); }, 700);
        return;
      }
      const s = Math.floor(d / 1000);
      setCountdown({ days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 });
    }, 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available = collection.filter(s => s.ipfsCid && !mintedNames.has(s.name));
  const totalSupply = collection.filter(s => s.ipfsCid).length;
  const totalMinted = mintedNames.size;

  // Coverflow carousel items — mirrors RentModal visibleItems logic
  const carouselItems = useMemo(() => {
    const total = mintedSlots.length;
    if (total < 2) return [];
    const maxVisible = total <= 3 ? 3 : 5;
    const sideCount = Math.floor(maxVisible / 2);
    const items: { slot: CollectionSlot; index: number; position: string }[] = [];
    for (let offset = -sideCount; offset <= sideCount; offset++) {
      const index = (previewIndex + offset + total) % total;
      items.push({
        slot: mintedSlots[index],
        index,
        position: offset === 0 ? 'active' : offset < 0 ? `left-${Math.abs(offset)}` : `right-${offset}`,
      });
    }
    return items;
  }, [mintedSlots, previewIndex]);

  // Keyboard navigation for carousel
  useEffect(() => {
    if (mintedSlots.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const total = mintedSlots.length;
      if (e.key === 'ArrowLeft')  setPreviewIndex(i => (i - 1 + total) % total);
      if (e.key === 'ArrowRight') setPreviewIndex(i => (i + 1) % total);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mintedSlots]);

  // Invalidate caches on network change
  useEffect(() => { _lucidCachePromise = null; _lucidCacheNetwork = null; _policyCache = null; }, [network]);

  // ── Load collection metadata ────────────────────────────────────────────────
  useEffect(() => {
    fetch('/data/collection.json')
      .then(r => r.json())
      .then((data: CollectionSlot[]) => setCollection(data))
      .catch(err => console.error('Failed to load collection.json:', err));
  }, []);

  // ── Load policy ID + on-chain stats (reads via Koios, no Blockfrost quota) ──
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setStatsLoading(true);
      try {
        const policy = await loadMintPolicy();
        if (cancelled) return;
        setPolicyId(policy.policyId);

        const minted = await withRetry(() => fetchMintedNames(policy.policyId, network));
        if (cancelled) return;
        setMintedNames(minted);

        // Grab featured image from Blockfrost asset info
        if (minted.size > 0) {
          const { url: bfUrl, apiKey: bfKey } = blockfrostConfig(network);
          const firstName = [...minted][0];
          const nameHex = Array.from(new TextEncoder().encode(firstName)).map(b => b.toString(16).padStart(2, '0')).join('');
          const assetId = policy.policyId + nameHex;
          const res = await fetch(`${bfUrl}/assets/${assetId}`, { headers: { project_id: bfKey } });
          if (res.ok) {
            const info = await res.json() as { onchain_metadata?: Record<string, unknown> };
            const rawImg = (info?.onchain_metadata as any)?.image;
            if (rawImg && !cancelled) {
              const flat = Array.isArray(rawImg) ? rawImg.join('') : String(rawImg);
              if (flat.startsWith('ipfs://')) {
                setFeaturedNftImage('https://ipfs.io/ipfs/' + flat.slice(7));
              }
            }
          }
        }
      } catch (err) {
        console.error('Stats load error:', err);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [network]);


  // ── Wallet handlers ─────────────────────────────────────────────────────────
  const handleSelectWallet = () => {
    if (connectedWallet) {
      setConnectedWallet(null); setFullWalletAddress(null); setWallets([]);
      return;
    }
    const detected = getAvailableWallets();
    if (detected.length === 0) { setShowNoWalletModal(true); return; }
    setWallets(detected);
    if (detected.length === 1) connectWallet(detected[0].key);
  };

  const connectWallet = async (key: string) => {
    try {
      const api     = await (window as any).cardano[key].enable();
      // makeWalletFromAPI decodes the CIP-30 address via CML (no provider/Blockfrost needed)
      const address = await makeWalletFromAPI({} as any, api as WalletApi).address();
      setConnectedWallet({ name: key, api });
      setFullWalletAddress(address ?? null);
      setWallets([]);
    } catch (err) {
      console.error('Wallet connect error:', err);
      raiseWalletNotice(err);
    }
  };

  useEffect(() => { connectedWalletRef.current = connectedWallet; }, [connectedWallet]);

  const refreshWallet = async (): Promise<boolean> => {
    const cur = connectedWalletRef.current;
    if (!cur) return false;
    try {
      const api     = await (window as any).cardano[cur.name].enable();
      const updated = { ...cur, api };
      connectedWalletRef.current = updated;
      setConnectedWallet(updated);
      return true;
    } catch { return false; }
  };

  const withWalletRetry = async <T,>(op: () => Promise<T>): Promise<T> => {
    try { return await op(); }
    catch (err) {
      if ((err as any)?.code !== -3) throw err;
      if (!(await refreshWallet())) throw err;
      return await op();
    }
  };

  const handleSignBtnClick = () => {
    if (signBtnAnim !== 'idle') return;
    setSignBtnAnim('out');
    setTimeout(() => { handleSelectWallet(); setSignBtnAnim('in'); setTimeout(() => setSignBtnAnim('idle'), 300); }, 280);
  };

  // ── Admin: duplicate detection + burn ────────────────────────────────────────
  const checkDuplicates = async () => {
    if (!policyId || mintedNames.size === 0) return;
    setCheckingDups(true);
    setDupError(null);
    setDuplicates([]);
    try {
      const { url: bfUrl, apiKey: bfKey } = blockfrostConfig(network);
      const dups: Array<{ name: string; mintCount: number }> = [];
      let page = 1;
      const COUNT = 100;
      while (true) {
        const res = await fetch(
          `${bfUrl}/assets/policy/${policyId}?count=${COUNT}&page=${page}`,
          { headers: { project_id: bfKey } },
        );
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`Blockfrost error ${res.status}`);
        const data: Array<{ asset: string; quantity: string }> = await res.json();
        for (const { asset, quantity } of data) {
          const qty = Number(quantity);
          if (qty !== 1) {
            const hexName = asset.slice(policyId.length);
            try {
              const name = new TextDecoder().decode(Uint8Array.from(
                hexName.match(/.{1,2}/g)!.map(b => parseInt(b, 16))
              ));
              dups.push({ name, mintCount: qty });
            } catch {}
          }
        }
        if (data.length < COUNT) break;
        page++;
      }
      setDuplicates(dups);
    } catch (err) {
      setDupError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingDups(false);
    }
  };

  const burnDuplicate = async (slotName: string) => {
    if (!fullWalletAddress) return;
    setBurningSlot(slotName);
    setBurnResults(prev => ({ ...prev, [slotName]: '' }));
    try {
      const lucid = await initLucid(network);
      selectWallet(lucid, connectedWalletRef.current!.api);
      const policy    = await loadMintPolicy();
      const assetUnit = policy.policyId + fromText(slotName);
      const redeemer  = Data.to(new Constr(0, []));

      const tx = await lucid.newTx()
        .mintAssets({ [assetUnit]: -1n }, redeemer)
        .attach.MintingPolicy({ type: 'PlutusV3', script: policy.compiledCode })
        .addSigner(fullWalletAddress)
        .complete();

      const txHash = await tx.sign.withWallet().complete().then(s => s.submit());
      setBurnResults(prev => ({ ...prev, [slotName]: txHash }));
      setDuplicates(prev => prev
        .map(d => d.name === slotName ? { ...d, mintCount: d.mintCount - 1 } : d)
        .filter(d => d.mintCount > 1)
      );
    } catch (err) {
      raiseWalletNotice(err);
      const msg = err instanceof Error ? err.message : String(err);
      setBurnResults(prev => ({ ...prev, [slotName]: `Error: ${msg}` }));
    } finally {
      setBurningSlot(null);
    }
  };

  // ── Mint ─────────────────────────────────────────────────────────────────────
  const handleMint = async () => {
    if (!connectedWallet || !fullWalletAddress) return;

    // Re-fetch minted list just before mint (bypasses cache by clearing it first)
    const policy = await loadMintPolicy();
    sessionStorage.removeItem(`minted_${policy.policyId}`);
    const freshMinted = await withRetry(() => fetchMintedNames(policy.policyId, network));
    setMintedNames(freshMinted);

    const stillAvailable = collection.filter(s => s.ipfsCid && !freshMinted.has(s.name));
    if (stillAvailable.length === 0) {
      setMintError('This collection is fully minted out!');
      return;
    }

    // Cryptographically random shuffle — one fresh CSPRNG draw per swap (Fisher-Yates).
    // Generates all swap values up-front in a single getRandomValues call for efficiency,
    // matching the donada draw script's batch-entropy approach.
    const qty = Math.min(mintQuantity, stillAvailable.length);
    const reducedWarning = qty < mintQuantity
      ? `Only ${qty} NFT${qty > 1 ? 's' : ''} remaining — minting ${qty} instead.`
      : null;
    const n = stillAvailable.length;
    const randBuf = crypto.getRandomValues(new Uint32Array(n));
    const indices = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = randBuf[i] % (i + 1);
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const slots = indices.slice(0, qty).map(i => stillAvailable[i]);

    setIsMinting(true);
    setMintError(null);
    setMintWarning(reducedWarning);
    setMintedSlots([]);

    try {
      const txHash = await withWalletRetry(async () => {
        const l = await initLucid(network);
        selectWallet(l, connectedWalletRef.current!.api);

        const redeemer = Data.to(new Constr(0, []));

        const mintAssets: Record<string, bigint> = {};
        const metadataTokens: Record<string, unknown> = {};
        for (const slot of slots) {
          mintAssets[policy.policyId + fromText(slot.name)] = 1n;
          metadataTokens[slot.name] = {
            name:        slot.name,
            image:       `ipfs://${slot.ipfsCid}`,
            mediaType:   slot.mediaType ?? 'image/jpeg',
            description: slot.description,
            ...(slot.traits ?? {}),
          };
        }

        const tx = await l.newTx()
          .mintAssets(mintAssets, redeemer)
          .attach.MintingPolicy({ type: 'PlutusV3', script: policy.compiledCode })
          .attachMetadata(721, { [policy.policyId]: metadataTokens } as any)
          .pay.ToAddress(PROJECT_WALLET_ADDRESS, { lovelace: MINT_PRICE_LOVELACE * BigInt(slots.length) })
          .complete();

        const signed = await tx.sign.withWallet().complete();
        return signed.submit();
      });

      setMintedSlots(slots);
      setPreviewIndex(0);
      setTxConfirm({
        title: slots.length > 1 ? `${slots.length} NFTs Minted!` : 'NFT Minted!',
        txHash,
      });
      setMintedNames(prev => new Set([...prev, ...slots.map(s => s.name)]));
      if (!featuredNftImage) {
        const first = slots.find(s => s.ipfsCid);
        if (first) setFeaturedNftImage(`https://ipfs.io/ipfs/${first.ipfsCid}`);
      }
    } catch (err) {
      console.error('Mint failed:', err);
      raiseWalletNotice(err);
      const code = (err as any)?.code;
      if (code !== -2 && code !== -3) {
        const msg = err instanceof Error ? err.message : String(err);
        setMintError(msg.includes('ValueNotConservedUTxO') || msg.includes('BadInputsUTxO')
          ? 'That slot was just taken — please try again.'
          : msg);
      }
    } finally {
      setIsMinting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const canMint = !!connectedWallet && available.length > 0 && !isMinting && !!policyId && !countdown;

  return (
    <div className={`app-container${isDimming ? ' dimming' : ''}`}>
      <header className="header">
        <div className="logo-group">
          <h1 className="logo">
            <a href="https://donada.io" target="_blank" rel="noopener noreferrer"><span className="logo-don">DON</span><span className="logo-ada">ADA</span> MINT</a>
          </h1>
          <button className="theme-toggle" onClick={() => {
            setIsDimming(true);
            setTimeout(() => {
              setIsDarkMode(d => {
                const next = !d;
                localStorage.setItem('theme', next ? 'dark' : 'light');
                return next;
              });
              setIsDimming(false);
            }, 150);
          }}>
            {isDarkMode ? '[dark]' : '[light]'}
          </button>
        </div>

        <div className="user-controls">
          <div className="sign-btn-wrapper">
            <button
              className={`select-btn sign-btn-${signBtnAnim}`}
              onClick={handleSignBtnClick}
              disabled={signBtnAnim !== 'idle'}
            >
              {connectedWallet ? 'Disconnect Wallet' : 'Sign In'}
            </button>
          </div>
          <span className="user-label">
            {connectedWallet ? `${connectedWallet.name} Connected` : '[No Wallet]'}
          </span>
        </div>
      </header>

      {walletNotice && (
        <div className="wallet-notice" role="alert">
          <button className="wallet-notice-close" onClick={() => setWalletNotice(null)} aria-label="Dismiss">✕</button>
          <p className="wallet-notice-title">Wallet Connection Issue</p>
          <p className="wallet-notice-body">
            {walletNotice === 'locked'
              ? 'Your wallet is locked. Please unlock it and refresh the page to reconnect.'
              : 'The wallet connection was lost. Please reconnect the dapp in your wallet extension, then refresh the page.'}
          </p>
          <button className="wallet-notice-refresh" onClick={() => window.location.reload()}>
            Refresh Page
          </button>
        </div>
      )}

      {wallets.length > 1 && !connectedWallet && (
        <div className="wallet-list">
          {wallets.map(w => (
            <button
              key={w.key}
              className="wallet-icon-btn"
              onClick={() => connectWallet(w.key)}
              style={{ '--wallet-color': WALLET_BRAND_COLORS[w.key.toLowerCase()] ?? '#111' } as React.CSSProperties}
            >
              {w.icon
                ? <img src={w.icon} alt={w.name} />
                : <span className="wallet-icon-btn__fallback">{w.name.slice(0, 2).toUpperCase()}</span>
              }
              <span className="wallet-icon-btn__name">{w.name}</span>
            </button>
          ))}
        </div>
      )}

      <main className="main-content">
        <div className="nft-card">
          <div className="nft-top-row">
            {/* Featured image */}
            <div className="nft-image">
              <div className={`nft-image-frame${countdown ? ' countdown-active' : ''}${mintedSlots.length > 0 ? ' minted-active' : ''}`}>
                {countdown ? (
                  <div className={`nft-image-inner nft-countdown${countdownFading ? ' fading' : ''}`}>
                    <div className="countdown-label">Minting opens in</div>
                    <div className="countdown-timer">
                      <span className="countdown-unit"><span className="countdown-num">{String(countdown.days).padStart(2, '0')}</span><span className="countdown-seg">D</span></span>
                      <span className="countdown-sep">:</span>
                      <span className="countdown-unit"><span className="countdown-num">{String(countdown.hours).padStart(2, '0')}</span><span className="countdown-seg">H</span></span>
                      <span className="countdown-sep">:</span>
                      <span className="countdown-unit"><span className="countdown-num">{String(countdown.minutes).padStart(2, '0')}</span><span className="countdown-seg">M</span></span>
                      <span className="countdown-sep">:</span>
                      <span className="countdown-unit"><span className="countdown-num">{String(countdown.seconds).padStart(2, '0')}</span><span className="countdown-seg">S</span></span>
                    </div>
                  </div>
                ) : isMinting ? (
                  <div className="nft-image-inner nft-pending">
                    <span className="nft-pending-text">
                      Your NFT{mintQuantity > 1 ? 's' : ''} will be displayed
                      here on blockchain confirmation
                    </span>
                    <span className="nft-pending-loading">
                      Loading<span className="loading-dots">...</span>
                    </span>
                  </div>
                ) : mintedSlots.length > 0 ? (
                  <div className="nft-minted-carousel">
                    {/* Large preview — always shows the active slot */}
                    <div
                      className="nft-minted-preview"
                      onClick={() => setEnlargedImage(`https://ipfs.blockfrost.dev/ipfs/${mintedSlots[previewIndex].ipfsCid}`)}
                    >
                      <img
                        src={`https://ipfs.blockfrost.dev/ipfs/${mintedSlots[previewIndex].ipfsCid}`}
                        alt={mintedSlots[previewIndex].name}
                      />
                      <div className="nft-minted-preview-label">{mintedSlots[previewIndex].name}</div>
                    </div>
                    {/* Coverflow carousel — only when multiple NFTs minted */}
                    {mintedSlots.length > 1 && (
                      <div
                        className={`nft-minted-coverflow count-${mintedSlots.length}`}
                        style={{ touchAction: 'pan-y' }}
                        onTouchStart={e => { carouselTouchRef.current.startX = e.touches[0].clientX; }}
                        onTouchEnd={e => {
                          const delta = e.changedTouches[0].clientX - carouselTouchRef.current.startX;
                          if (Math.abs(delta) < 30) return;
                          const total = mintedSlots.length;
                          setPreviewIndex(i => delta < 0 ? (i + 1) % total : (i - 1 + total) % total);
                        }}
                      >
                        {carouselItems.map(({ slot, index, position }) => (
                          <div
                            key={position}
                            className={`nft-minted-cf-frame ${position}`}
                            onClick={() => setPreviewIndex(index)}
                          >
                            <img src={`https://ipfs.blockfrost.dev/ipfs/${slot.ipfsCid}`} alt={slot.name} />
                            {position !== 'active' && <div className="nft-minted-cf-dim" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={`nft-image-inner${featuredNftImage ? ' has-image' : ''}`}>
                    {featuredNftImage
                      ? <img src={featuredNftImage} alt={COLLECTION_NAME} />
                      : statsLoading ? 'Loading…' : 'NFT IMAGE'}
                  </div>
                )}
                {mintedSlots.length === 0 && (
                  <div className="nft-details">
                    <p className="mint-name">Collection: {COLLECTION_NAME}</p>
                    {policyId && (
                      <p className="policy-id" title={policyId}>
                        Policy: {policyId.slice(0, 10)}…{policyId.slice(-8)}
                      </p>
                    )}
                    <p className="meta">
                      {statsLoading ? 'Loading…' : `${totalMinted} / ${totalSupply || '—'} minted`}
                    </p>
                  </div>
                )}
              </div>
            </div>

          </div>

          <div className="info-sections">
            {/* Top-left */}
            <div className="info-block">
              <p className="label">Mint Price</p>
              <div className="price-value-row">
                <p className="value">~₳ 500</p>
                <button className="price-info-toggle" onClick={() => setPriceExpanded(x => !x)} aria-label="Price details">
                  {priceExpanded ? '−' : '+'}
                </button>
              </div>
              <p className={`price-info-text${priceExpanded ? '' : ' price-info-hidden'}`}>
                Fees included — total should come to around ₳ 500, but may be slightly over depending on network conditions.
              </p>
            </div>

            {/* Top-right */}
            <div className="info-block">
              <p className="label">Remaining</p>
              <p className="value">
                {statsLoading ? '—' : `${available.length} / ${totalSupply || '—'}`}
              </p>
            </div>

            {/* Full-width divider */}
            <hr className="section-break grid-hr" />

            {/* Bottom-left */}
            <div className="info-block info-block-bottom">
              <p className="label">Jackpot</p>
              <div className="price-value-row">
                <p className="value">
                  {statsLoading
                    ? '—'
                    : `₳ ${((totalMinted * Number(MINT_PRICE_LOVELACE) / 1_000_000) * JACKPOT_PERCENT).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                </p>
                <button className="price-info-toggle" onClick={() => setJackpotExpanded(x => !x)} aria-label="Jackpot details">
                  {jackpotExpanded ? '−' : '+'}
                </button>
              </div>
              <p className={`price-info-text${jackpotExpanded ? '' : ' price-info-hidden'}`}>
                Jackpot reflects 20% of total mint revenue at the time this page was loaded. The full jackpot is distributed across 4 quarterly drawings.
              </p>
            </div>

            {/* Bottom-right */}
            <div className="info-block info-block-bottom">
              {!connectedWallet ? (
                <div className="action-text">Connect your wallet to mint</div>
              ) : available.length === 0 && !statsLoading ? (
                <div className="action-text">Sold out</div>
              ) : (
                <>
                  <div className="action-text">Mint random NFT{mintQuantity > 1 ? 's' : ''}</div>
                  <div className="qty-mint-group">
                    <div
                      className="qty-wheel"
                      onWheel={e => {
                        e.preventDefault();
                        const maxQty = Math.min(5, available.length);
                        setMintQuantity(q => {
                          const next = q + (e.deltaY < 0 ? 1 : -1);
                          return next > maxQty ? 1 : next < 1 ? maxQty : next;
                        });
                      }}
                    >
                      <button
                        className="qty-arrow"
                        onClick={() => setMintQuantity(q => { const maxQty = Math.min(5, available.length); return q >= maxQty ? 1 : q + 1; })}
                      >▲</button>
                      <span className="qty-value">{mintQuantity}</span>
                      <button
                        className="qty-arrow"
                        onClick={() => setMintQuantity(q => q <= 1 ? Math.min(5, available.length) : q - 1)}
                      >▼</button>
                    </div>
                    <div className={countdown ? 'mint-btn-tooltip-wrap' : ''} title={countdown ? 'Minting opens tonight at 11PM CST' : undefined}>
                      <button
                        className="select-btn small"
                        disabled={!canMint}
                        onClick={handleMint}
                      >
                        {isMinting ? 'Minting…' : `Mint ₳${(Number(MINT_PRICE_LOVELACE) / 1_000_000) * mintQuantity}`}
                      </button>
                    </div>
                  </div>
                  {mintWarning && (
                    <div className="action-block">
                      <div className="action-text" style={{ fontSize: '0.75rem', color: '#b45309', wordBreak: 'break-all' }}>
                        {mintWarning}
                      </div>
                    </div>
                  )}
                  {mintError && (
                    <p style={{ fontSize: '0.75rem', color: 'red', wordBreak: 'break-all', margin: '4px 0 0' }}>
                      {mintError}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Admin panel */}
        {isAdmin && (
          <section className="admin-mint" style={{ width: '100%' }}>
            <h3>Admin</h3>

            <div className="action-block">
              <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Network:
                <button
                  className="select-btn"
                  style={{ padding: '0.2rem 0.75rem', fontSize: '0.8rem' }}
                  onClick={() => setNetwork(n => n === 'Mainnet' ? 'Preview' : 'Mainnet')}
                >
                  {network}
                </button>
              </label>
              <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Post-mint preview:
                <button
                  className="select-btn"
                  style={{ padding: '0.2rem 0.75rem', fontSize: '0.8rem' }}
                  onClick={() => {
                    if (mintedSlots.length > 0) {
                      setMintedSlots([]);
                      setPreviewIndex(0);
                    } else {
                      setMintedSlots(collection.slice(0, 4));
                      setPreviewIndex(0);
                    }
                  }}
                >
                  {mintedSlots.length > 0 ? 'Clear' : 'Preview Minted'}
                </button>
              </label>
            </div>

            {policyId && (
              <p style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.5rem', wordBreak: 'break-all' }}>
                Policy ID: {policyId}
              </p>
            )}

            <hr className="section-break" style={{ marginTop: '1rem' }} />
            <p style={{ fontSize: '0.8rem', fontWeight: 600, margin: '0.5rem 0' }}>Duplicate Check</p>

            <div className="action-block">
              <button
                className="select-btn small"
                onClick={checkDuplicates}
                disabled={checkingDups || !policyId || mintedNames.size === 0}
              >
                {checkingDups ? 'Checking…' : 'Check for Duplicates'}
              </button>
            </div>

            {dupError && (
              <p style={{ fontSize: '0.75rem', color: 'red', marginTop: '0.5rem' }}>{dupError}</p>
            )}

            {!checkingDups && duplicates.length === 0 && mintedNames.size > 0 && (
              <p style={{ fontSize: '0.75rem', opacity: 0.5, marginTop: '0.5rem' }}>
                No duplicates found.
              </p>
            )}

            {duplicates.length > 0 && (
              <div className="admin-dup-list">
                <p style={{ fontSize: '0.75rem', color: '#b45309', margin: '0.5rem 0' }}>
                  {duplicates.length} duplicate{duplicates.length > 1 ? 's' : ''} found — burn removes one copy at a time.
                </p>
                {duplicates.map(({ name, mintCount }) => (
                  <div key={name} className="admin-dup-row">
                    <span className="admin-dup-name">{name}</span>
                    <span className="admin-dup-count">×{mintCount}</span>
                    <button
                      className="select-btn small"
                      onClick={() => burnDuplicate(name)}
                      disabled={burningSlot === name}
                    >
                      {burningSlot === name ? 'Burning…' : 'Burn'}
                    </button>
                    {burnResults[name] && (
                      <span className="admin-dup-result" style={{
                        color: burnResults[name].startsWith('Error') ? 'red' : '#16a34a'
                      }}>
                        {burnResults[name].startsWith('Error')
                          ? burnResults[name]
                          : `✓ ${burnResults[name].slice(0, 12)}…`}
                      </span>
                    )}
                  </div>
                ))}
                <p style={{ fontSize: '0.7rem', opacity: 0.5, marginTop: '0.5rem' }}>
                  Note: can only burn tokens held in this wallet.
                </p>
              </div>
            )}
          </section>
        )}
      </main>

      {enlargedImage && (
        <div className="modal-backdrop" onClick={() => setEnlargedImage(null)}>
          <img
            className="image-enlarge"
            src={enlargedImage}
            alt="NFT"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {txConfirm && (
        <TxConfirmModal
          title={txConfirm.title}
          txHash={txConfirm.txHash}
          network={network}
          onClose={() => setTxConfirm(null)}
        />
      )}

      {!disclaimerAccepted && !disclaimerDeclined && (
        <DisclaimerModal
          onAccept={handleAcceptDisclaimer}
          onDecline={handleDeclineDisclaimer}
        />
      )}

      {disclaimerDeclined && (
        <div className="modal-backdrop">
          <div className="modal-sheet disclaimer-modal" style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
              You must accept the disclaimer to continue.
            </p>
            <p style={{ fontSize: '0.82rem', opacity: 0.6, marginBottom: '1.5rem' }}>
              This platform is only available in regions where sweepstakes are permitted.
            </p>
            <button className="select-btn" onClick={() => setDisclaimerDeclined(false)}>
              Go Back
            </button>
          </div>
        </div>
      )}

      {showNoWalletModal && (
        <div className="connect-prompt-overlay" onClick={() => setShowNoWalletModal(false)}>
          <div className="connect-prompt" onClick={e => e.stopPropagation()}>
            <button className="connect-prompt-close" onClick={() => setShowNoWalletModal(false)}>✕</button>
            <p className="connect-prompt-title">No Wallet Detected</p>
            <p className="connect-prompt-body">
              No Cardano wallet extension was found in your browser. Install one to get started.
            </p>
            <div className="no-wallet-links">
              {WALLET_DOWNLOADS.map(({ key, name, url }) => (
                <a
                  key={key}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="no-wallet-link"
                  style={{ '--wallet-color': WALLET_BRAND_COLORS[key] ?? '#111' } as React.CSSProperties}
                >
                  {name}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
