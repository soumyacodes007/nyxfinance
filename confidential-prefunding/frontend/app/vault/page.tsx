"use client"

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  ArrowRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Landmark,
  Coins,
  Lock,
  EyeOff,
  ShieldCheck,
  Radio,
  Wifi,
  WifiOff,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Types ───────────────────────────────────────────────────────────────────

interface DemoState {
  source: "live" | "cache" | "unavailable"
  error?: string
  snapshot?: {
    network?: { networkPassphrase?: string }
    accounts?: { alpha?: string | null; facility?: string | null; auditor?: string | null }
    contracts?: Record<string, string>
    product?: { latestSep31Transaction?: { senderId?: string | null } | null }
    dataSources?: {
      quote?: { oracleMode?: string; oracleSource?: string }
    }
  } | null
}

interface QuotePreview {
  collateralToken: string
  haircutBps: number
  maxTenorDays: number
  oraclePriceE7: string
  oracleUpdatedLedger: number | null
  source: "chain"
}

// Confidential collateral wrappers Alpha can pledge. cTBill reads live policy
// terms from the configured contract; cXAUm has no deployed contract yet, so
// its terms are shown as reference values until CXAUM_CONTRACT_ID exists.
const COLLATERAL_ASSETS = [
  { id: "cTBill" as const, underlying: "tTBill", description: "Tokenized T-Bill reserve", haircutBps: 1000, maxTenorDays: 5, wired: true, icon: Landmark },
  { id: "cXAUm" as const, underlying: "tXAUm", description: "Tokenized gold reserve", haircutBps: 1750, maxTenorDays: 5, wired: false, icon: Coins },
]
type CollateralAssetId = (typeof COLLATERAL_ASSETS)[number]["id"]

async function resolveDemoAlphaAccount(API: string, preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred
  const txId = process.env.NEXT_PUBLIC_DEMO_SEP31_TRANSACTION_ID ?? "sep31-alpha-001"
  const txRes = await fetch(`${API}/api/sep31/transaction?id=${encodeURIComponent(txId)}`)
  if (!txRes.ok) return null
  const tx = await txRes.json() as { sender_id?: string | null }
  return tx.sender_id ?? null
}

// ─── Status Badge (shared pattern from anchor page) ──────────────────────────

function StatusBadge({ label, variant }: { label: string; variant: "success" | "warning" | "neutral" | "pending" }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-[10px] font-medium tracking-wide uppercase whitespace-nowrap",
      variant === "success" && "bg-[#1a6042]/10 text-[#1a6042] border border-[#1a6042]/20",
      variant === "warning" && "bg-[#92400e]/10 text-[#92400e] border border-[#92400e]/20",
      variant === "pending" && "bg-[rgba(55,50,47,0.06)] text-[#605A57] border border-[rgba(55,50,47,0.15)]",
      variant === "neutral" && "bg-[rgba(55,50,47,0.06)] text-[#8a8480] border border-[rgba(55,50,47,0.12)]"
    )}>
      <span className={cn(
        "w-1.5 h-1.5 rounded-full flex-shrink-0",
        variant === "success" && "bg-[#1a6042]",
        variant === "warning" && "bg-[#92400e]",
        variant === "pending" && "bg-[#605A57]",
        variant === "neutral" && "bg-[#a8a29e]"
      )} />
      {label}
    </span>
  )
}

// ─── Metric Row ───────────────────────────────────────────────────────────────

function MetricRow({ label, value, badge, mono }: { label: string; value?: string; badge?: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-[9px] border-b border-[rgba(55,50,47,0.07)] last:border-0">
      <span className="text-[12px] text-[#8a8480] font-medium">{label}</span>
      {badge ?? (
        <span className={cn("text-[12px] text-[#37322F] font-medium", mono && "font-mono text-[11px]")}>
          {value}
        </span>
      )}
    </div>
  )
}

function IdBadge({ tag, value }: { tag: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 bg-white rounded-full border border-[rgba(55,50,47,0.12)] pl-1.5 pr-3 py-1 shadow-[0_1px_2px_rgba(55,50,47,0.05)]">
      <span className="text-[9px] font-bold tracking-[0.06em] uppercase bg-[#37322F] text-white rounded-full px-2 py-[3px] leading-none">
        {tag}
      </span>
      <span className="text-[13px] font-mono font-bold text-[#37322F] leading-none">
        {value}
      </span>
    </div>
  )
}

function shortAddr(value: string | null | undefined) {
  if (!value) return "Not configured"
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value
}

function shortNetworkName(passphrase: string | undefined) {
  if (!passphrase) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("test")) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("public")) return "Stellar Public"
  return "Stellar"
}

// ─── Page ────────────────────────────────────────────────────────────────────

function VaultPageInner() {
  const params = useSearchParams()
  const initialAsset = (params.get("collateral") as CollateralAssetId) ?? "cTBill"

  const [selectedAsset, setSelectedAsset] = useState<CollateralAssetId>(
    COLLATERAL_ASSETS.some((a) => a.id === initialAsset) ? initialAsset : "cTBill"
  )
  const [demo, setDemo] = useState<DemoState | null>(null)
  const [quote, setQuote] = useState<QuotePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  const assetMeta = COLLATERAL_ASSETS.find((a) => a.id === selectedAsset)!

  useEffect(() => {
    async function load() {
      setLoading(true)
      setQuote(null)
      setError(null)
      try {
        const demoRes = await fetch(`${API}/api/demo/state`)
        const demoJson = demoRes.ok ? (await demoRes.json()) as DemoState : null
        if (demoJson) setDemo(demoJson)

        // cXAUm has no deployed contract yet — skip the live policy read
        // and show reference terms. Swap this once CXAUM_CONTRACT_ID exists.
        if (!assetMeta.wired) {
          setError("Reference collateral terms — cXAUm contract not yet deployed")
          return
        }

        const alpha = await resolveDemoAlphaAccount(
          API,
          demoJson?.snapshot?.accounts?.alpha ??
            demoJson?.snapshot?.product?.latestSep31Transaction?.senderId
        )
        const collateralToken = demoJson?.snapshot?.contracts?.collateralToken
        if (alpha && collateralToken) {
          const quoteRes = await fetch(`${API}/api/prefunding/quote`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              account: alpha,
              collateralToken,
              requestedCreditAmount: "1",
              tenorDays: 1,
            }),
          })
          if (quoteRes.ok) setQuote(await quoteRes.json())
          else setError("Policy read unavailable — showing reference collateral terms")
        } else {
          setError("Contracts not fully configured — showing reference collateral terms")
        }
      } catch {
        setError("Backend unreachable — reference collateral terms shown")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [API, selectedAsset, assetMeta.wired])

  const oracleMode = demo?.snapshot?.dataSources?.quote?.oracleMode
  const isReflector = oracleMode === "reflector"
  const oracleSourceLabel = isReflector ? "Reflector" : "Mock Oracle Adapter"
  const haircutBps = quote?.haircutBps ?? assetMeta.haircutBps
  const maxTenorDays = quote?.maxTenorDays ?? assetMeta.maxTenorDays
  const collateralPolicyAddr = demo?.snapshot?.contracts?.collateralPolicy
  const oracleAdapterAddr = demo?.snapshot?.contracts?.oracleAdapter
  const collateralTokenAddr = quote?.collateralToken ?? demo?.snapshot?.contracts?.collateralToken
  const isLive = demo?.source === "live"
  const networkName = shortNetworkName(demo?.snapshot?.network?.networkPassphrase)
  const oracleFresh = Boolean(quote?.oracleUpdatedLedger)

  const oracleStatusLabel = !assetMeta.wired ? "Reference" : oracleFresh || !quote ? "Fresh" : "Stale"
  const oracleStatusVariant = !assetMeta.wired ? "pending" : oracleFresh || !quote ? "success" : "warning"

  return (
    <div className="h-screen w-full bg-[#F7F5F3] flex flex-col overflow-hidden">

      {/* Vertical rules */}
      <div className="pointer-events-none fixed inset-y-0 left-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[1px_0_0_white] z-50" />
      <div className="pointer-events-none fixed inset-y-0 right-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[-1px_0_0_white] z-50" />

      {/* ── Top bar ── */}
      <div className="flex-shrink-0 border-b border-[rgba(55,50,47,0.10)] bg-[#F7F5F3]/90 backdrop-blur-sm z-30">
        <div className="max-w-[1060px] mx-auto px-6 h-10 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[13px] font-medium text-[#37322F] hover:opacity-70 transition-opacity">
              Nyx
            </Link>
            <span className="w-[1px] h-3.5 bg-[rgba(55,50,47,0.15)]" />
            <span className="text-[11px] font-medium text-[#8a8480] tracking-[0.1em] uppercase">
              Collateral Vault
            </span>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="text-[10px] text-[#92400e] flex items-center gap-1">
                <WifiOff className="w-3 h-3" />{error}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              {isLive ? <Wifi className="w-3 h-3 text-[#1a6042]" /> : <span className="w-1.5 h-1.5 rounded-full bg-[#a8a29e]" />}
              {networkName}
            </span>
            <span className="w-[1px] h-3.5 bg-[rgba(55,50,47,0.15)]" />
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              <span>Oracle</span>
              <StatusBadge label={oracleSourceLabel} variant={isReflector ? "success" : "pending"} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Main area — fills remaining height ── */}
      <div className="flex-1 overflow-hidden">
        <div className="max-w-[1060px] mx-auto px-6 h-full py-6 grid grid-cols-[1fr_320px] gap-5 items-start">

          {/* ── Left column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Identity */}
            <div className="flex items-start justify-between flex-shrink-0">
              <div>
                <Link
                  href="/anchor"
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-[#a8a29e] hover:text-[#605A57] tracking-[0.1em] uppercase mb-1 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" /> Anchor Operator
                </Link>
                <h1 className="text-[26px] font-serif text-[#37322F] leading-tight">
                  Confidential Collateral Vault
                </h1>
                <p className="text-[12px] text-[#8a8480] mt-0.5">Alpha Remit · Private RWA reserves</p>
              </div>
              <StatusBadge label="Eligible" variant="success" />
            </div>

            {/* Collateral card — grows to fill */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl flex flex-col overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">

              {/* Card header */}
              <div className="flex-shrink-0 px-5 py-3.5 border-b border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[rgba(55,50,47,0.06)] flex items-center justify-center flex-shrink-0">
                    <Landmark className="w-3.5 h-3.5 text-[#605A57]" />
                  </div>
                  <IdBadge tag="Asset" value={selectedAsset} />
                </div>
                <StatusBadge label="Eligible" variant="success" />
              </div>

              {/* Asset tabs — browsing, no lock-in on this page */}
              <div className="flex-shrink-0 px-5 pt-4">
                <div className="flex gap-1.5">
                  {COLLATERAL_ASSETS.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setSelectedAsset(a.id)}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-[13px] font-bold font-mono border transition-all",
                        selectedAsset === a.id
                          ? "bg-[#37322F] text-white border-[#37322F]"
                          : "bg-white text-[#605A57] border-[rgba(55,50,47,0.14)] hover:border-[rgba(55,50,47,0.30)]"
                      )}
                    >
                      <a.icon className={cn("w-3.5 h-3.5", selectedAsset === a.id ? "text-white/70" : "text-[#a8a29e]")} />
                      {a.id}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[#a8a29e] mt-2 leading-relaxed">
                  {assetMeta.id} wraps {assetMeta.underlying} · {assetMeta.description}
                  {!assetMeta.wired && " · reference terms, contract not yet deployed"}
                </p>
              </div>

              {/* Metrics */}
              <div className="flex-1 px-5 py-1 overflow-hidden">
                {loading ? (
                  <div className="flex flex-col gap-0 pt-3">
                    {[1,2,3,4,5,6].map(i => (
                      <div key={i} className="flex justify-between py-[9px] border-b border-[rgba(55,50,47,0.07)]">
                        <div className="h-3 w-24 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="pt-1">
                    <MetricRow label="Eligibility" badge={<StatusBadge label="Eligible" variant="success" />} />
                    <MetricRow label="Policy source" value="CollateralPolicyRegistry" mono />
                    <MetricRow
                      label="Oracle"
                      badge={<StatusBadge label={oracleStatusLabel} variant={oracleStatusVariant} />}
                    />
                    <MetricRow label="Oracle source" badge={<StatusBadge label={oracleSourceLabel} variant={isReflector ? "success" : "pending"} />} />
                    <MetricRow label="Haircut" value={`${(haircutBps / 100).toFixed(0)}%`} />
                    <MetricRow label="Maximum tenor" value={`${maxTenorDays} days`} />
                    <MetricRow
                      label="Public visibility"
                      badge={
                        <span className="flex items-center gap-1 text-[12px] text-[#8a8480] font-medium">
                          <EyeOff className="w-3.5 h-3.5 text-[#a8a29e]" />
                          Hidden
                        </span>
                      }
                    />
                    <MetricRow
                      label="Collateral amount"
                      badge={
                        <span className="flex items-center gap-1 text-[12px] text-[#8a8480] font-medium italic">
                          <Lock className="w-3.5 h-3.5 text-[#a8a29e]" />
                          Private
                        </span>
                      }
                    />
                  </div>
                )}
              </div>

              {/* Card footer — CTA */}
              <div className="flex-shrink-0 px-5 py-4 border-t border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <p className="text-[11px] text-[#a8a29e] max-w-[340px] leading-relaxed">
                  Reserve size stays private end to end — only eligibility and policy terms are public.
                </p>
                <Link
                  href={`/credit?collateral=${selectedAsset}`}
                  className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                    shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                    hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                    transition-all duration-200"
                >
                  <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                  Request prefunding
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Hidden reserve hero */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-2.5">
                Collateral amount
              </p>
              <div className="flex items-end justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-[#a8a29e]" />
                  <span className="text-[24px] font-serif text-[#a8a29e] leading-none italic">
                    ••••••
                  </span>
                </div>
              </div>
              <div className="w-full h-[1px] bg-[rgba(55,50,47,0.08)] mb-3" />
              <p className="text-[11px] text-[#8a8480] leading-relaxed">
                Reserve size is never exposed publicly — {selectedAsset} balance is held in a confidential
                OZ token wrapper. Only the auditor can decrypt the true value.
              </p>
            </div>

            {/* Privacy boundary card — grows */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-3">
                Privacy boundary
              </p>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#1a6042]" /> Asset class
                  </span>
                  <span className="text-[11px] text-[#37322F] font-mono">{selectedAsset}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#1a6042]" /> Eligibility status
                  </span>
                  <span className="text-[11px] text-[#1a6042] font-medium">Public</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-[#1a6042]" /> Oracle freshness
                  </span>
                  <span className="text-[11px] text-[#1a6042] font-medium">Public</span>
                </div>
                <div className="w-full h-[1px] bg-[rgba(55,50,47,0.08)] my-1" />
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#8a8480] font-medium flex items-center gap-1.5">
                    <EyeOff className="w-3.5 h-3.5 text-[#a8a29e]" /> Reserve size
                  </span>
                  <span className="text-[11px] text-[#a8a29e] font-medium">Hidden</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-[#8a8480] font-medium flex items-center gap-1.5">
                    <EyeOff className="w-3.5 h-3.5 text-[#a8a29e]" /> Corridor volume
                  </span>
                  <span className="text-[11px] text-[#a8a29e] font-medium">Hidden</span>
                </div>
              </div>
            </div>

            {/* Verification drawer */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-[rgba(55,50,47,0.02)] transition-colors"
              >
                <span className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase">
                  Verification details
                </span>
                {drawerOpen
                  ? <ChevronUp className="w-3 h-3 text-[#a8a29e]" />
                  : <ChevronDown className="w-3 h-3 text-[#a8a29e]" />
                }
              </button>
              {drawerOpen && (
                <div className="border-t border-[rgba(55,50,47,0.08)] px-4 py-3 flex flex-col gap-2.5 max-h-[45vh] overflow-y-auto">
                  {[
                    { label: "CollateralPolicyRegistry", value: shortAddr(collateralPolicyAddr) },
                    { label: "OracleAdapter contract",   value: shortAddr(oracleAdapterAddr) },
                    { label: "Oracle updated ledger",    value: quote?.oracleUpdatedLedger ? String(quote.oracleUpdatedLedger) : "Pending read" },
                    { label: "Policy read status",       value: quote ? "Read from chain" : "Reference values (not yet read)" },
                  ].map(row => (
                    <div key={row.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-[#a8a29e] font-medium">{row.label}</span>
                      <span className="text-[11px] font-mono text-[#605A57] break-all">
                        {row.value}
                      </span>
                    </div>
                  ))}
                  <a
                    href={`${API}/api/demo/state`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 text-[11px] text-[#605A57] hover:text-[#37322F] transition-colors font-medium"
                  >
                    View collateral token {shortAddr(collateralTokenAddr)} <ArrowUpRight className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

export default function VaultPage() {
  return (
    <Suspense fallback={null}>
      <VaultPageInner />
    </Suspense>
  )
}
