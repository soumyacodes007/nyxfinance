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
  Banknote,
  Lock,
  Loader2,
  CircleCheck,
  AlertTriangle,
  Cpu,
  Wifi,
  WifiOff,
  ShieldCheck,
  Pencil,
  Sparkles,
  Landmark,
  Coins,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Types ───────────────────────────────────────────────────────────────────

interface DemoState {
  source: "live" | "cache" | "unavailable"
  snapshot?: {
    network?: { networkPassphrase?: string }
    accounts?: { alpha?: string | null }
    contracts?: Record<string, string>
    stellar?: { rpc?: { latestLedgerSequence?: number | null } }
    product?: {
      latestSep31Transaction?: { id: string; senderId?: string | null } | null
      latestProofJobId?: string | null
    }
    dataSources?: { privacy?: { proverMode?: string } }
  } | null
}

interface PrefundingQuote {
  id: string
  account: string
  anchorTransactionId: string | null
  collateralToken: string
  requestedCreditAmount: string
  tenorDays: number
  participantApproved: boolean
  oraclePriceE7: string
  oracleUpdatedLedger: number | null
  haircutBps: number
  maxTenorDays: number
  feeBps: number
  feeAmount: string
  expiresAt: string
  source: "chain" | "reference"
}

interface DemoFlowOpenResult {
  state: {
    anchorTransactionId: string | null
    positionId: string | null
    proof: {
      jobId: string
      status: string
      publicInputsHex: string | null
      proofHex: string | null
      verifierContractId: string | null
    } | null
    open: { txHash: string; ledger?: number | null } | null
  }
}

type Phase = "input" | "quoted" | "proving" | "verified" | "failed"
type ProofStage = 0 | 1 | 2 | 3 | 4 // 0 = not started, 1-4 = stage index

const PROOF_STAGES = [
  "Preparing private witness",
  "Generating collateral sufficiency proof",
  "Submitting proof to Stellar",
  "Verifier accepted proof",
]

// ─── Shared components (same pattern as anchor / vault pages) ───────────────

function StatusBadge({ label, variant }: { label: string; variant: "success" | "warning" | "neutral" | "pending" | "danger" }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-[10px] font-medium tracking-wide uppercase whitespace-nowrap",
      variant === "success" && "bg-[#1a6042]/10 text-[#1a6042] border border-[#1a6042]/20",
      variant === "warning" && "bg-[#92400e]/10 text-[#92400e] border border-[#92400e]/20",
      variant === "danger" && "bg-[#9a2c1a]/10 text-[#9a2c1a] border border-[#9a2c1a]/20",
      variant === "pending" && "bg-[rgba(55,50,47,0.06)] text-[#605A57] border border-[rgba(55,50,47,0.15)]",
      variant === "neutral" && "bg-[rgba(55,50,47,0.06)] text-[#8a8480] border border-[rgba(55,50,47,0.12)]"
    )}>
      <span className={cn(
        "w-1.5 h-1.5 rounded-full flex-shrink-0",
        variant === "success" && "bg-[#1a6042]",
        variant === "warning" && "bg-[#92400e]",
        variant === "danger" && "bg-[#9a2c1a]",
        variant === "pending" && "bg-[#605A57]",
        variant === "neutral" && "bg-[#a8a29e]"
      )} />
      {label}
    </span>
  )
}

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.14em] uppercase mb-1.5">
      {children}
    </p>
  )
}

function UsdcIcon({ size = 14 }: { size?: number }) {
  return (
    <img
      src="/usdc.png"
      alt="USDC"
      className="rounded-full flex-shrink-0"
      style={{ width: size, height: size }}
    />
  )
}

const REFERENCE_FEE_BPS = 35

async function resolveDemoAlphaAccount(API: string, preferred?: string | null): Promise<{
  account: string | null
  anchorTransactionId: string | null
}> {
  if (preferred) return { account: preferred, anchorTransactionId: null }

  const txId = process.env.NEXT_PUBLIC_DEMO_SEP31_TRANSACTION_ID ?? "sep31-alpha-001"
  const txRes = await fetch(`${API}/api/sep31/transaction?id=${encodeURIComponent(txId)}`)
  if (txRes.ok) {
    const tx = await txRes.json() as { id?: string; sender_id?: string | null }
    return { account: tx.sender_id ?? null, anchorTransactionId: tx.id ?? txId }
  }

  const bootstrapRes = await fetch(`${API}/api/demo-flow/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anchorTransactionId: txId, kybStatus: "ACCEPTED" }),
  })
  if (bootstrapRes.ok) {
    const bootstrap = await bootstrapRes.json()
    return {
      account: bootstrap.transaction?.sender_id ?? bootstrap.transaction?.senderId ?? null,
      anchorTransactionId: bootstrap.transaction?.id ?? txId,
    }
  }

  const seedRes = await fetch(`${API}/api/sep31/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: txId,
      status: "pending_sender",
      amount_in: "50000",
      amount_out: "50000",
      asset_code: "cUSDC",
      fields: { corridor: "USD-PHP", settlement_window_days: 3 },
    }),
  })
  if (!seedRes.ok) return { account: null, anchorTransactionId: null }
  const seeded = await seedRes.json() as { id?: string; sender_id?: string | null }
  return { account: seeded.sender_id ?? null, anchorTransactionId: seeded.id ?? txId }
}

// Confidential collateral wrappers available for this position.
// cTBill reads live policy terms from the configured contract; cXAUm has no
// deployed contract yet, so its terms are shown as reference values.
const COLLATERAL_ASSETS = [
  { id: "cTBill" as const, underlying: "tTBill", description: "Tokenized T-Bill reserve", haircutBps: 1000, maxTenorDays: 5, wired: true, icon: Landmark },
  { id: "cXAUm" as const, underlying: "tXAUm", description: "Tokenized gold reserve", haircutBps: 1750, maxTenorDays: 5, wired: false, icon: Coins },
]
type CollateralAssetId = (typeof COLLATERAL_ASSETS)[number]["id"]

function shortAddr(value: string | null | undefined) {
  if (!value) return "Not configured"
  return value.length > 22 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value
}

function shortQuoteId(id: string) {
  const stripped = id.includes("_") ? id.split("_").slice(1).join("_") : id
  return stripped.slice(0, 8)
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

function shortNetworkName(passphrase: string | undefined) {
  if (!passphrase) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("test")) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("public")) return "Stellar Public"
  return "Stellar"
}

function formatAmount(value: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric)
}

function dueDate(tenorDays: number) {
  const d = new Date()
  d.setDate(d.getDate() + tenorDays)
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d)
}

function explorerTxUrl(passphrase: string | undefined, hash: string) {
  const network = passphrase?.toLowerCase().includes("public") ? "public" : "testnet"
  return `https://stellar.expert/explorer/${network}/tx/${hash}`
}

// Public inputs layout (see demo-flow fixture): 9 × 32-byte fields —
// [collX, collY, credX, credY, oraclePrice, haircut, tenor, lockKey, nullifier]
function nullifierFromPublicInputs(publicInputsHex: string | null | undefined) {
  if (!publicInputsHex) return null
  const hex = publicInputsHex.replace(/^0x/, "")
  return hex.length >= 64 ? hex.slice(-64) : null
}

// ─── Page ────────────────────────────────────────────────────────────────────

function CreditPageInner() {
  const params = useSearchParams()
  const initialAsset = (params.get("collateral") as CollateralAssetId) ?? "cTBill"

  const [demo, setDemo] = useState<DemoState | null>(null)
  const [initLoading, setInitLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedAsset, setSelectedAsset] = useState<CollateralAssetId>(
    COLLATERAL_ASSETS.some((a) => a.id === initialAsset) ? initialAsset : "cTBill"
  )
  const [amountInput, setAmountInput] = useState("50000")
  const [tenorInput, setTenorInput] = useState(3)
  const [phase, setPhase] = useState<Phase>("input")
  const [quote, setQuote] = useState<PrefundingQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [openResult, setOpenResult] = useState<DemoFlowOpenResult | null>(null)
  const [proofError, setProofError] = useState<string | null>(null)

  const [stage, setStage] = useState<ProofStage>(0)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API}/api/demo/state`)
        if (res.ok) setDemo(await res.json())
        else setError("Demo state unavailable — using reference context")
      } catch {
        setError("Backend unreachable — reference context shown")
      } finally {
        setInitLoading(false)
      }
    }
    load()
  }, [API])

  const alpha =
    demo?.snapshot?.accounts?.alpha ??
    demo?.snapshot?.product?.latestSep31Transaction?.senderId
  const collateralToken = demo?.snapshot?.contracts?.collateralToken
  const proverMode = demo?.snapshot?.dataSources?.privacy?.proverMode
  const isLocalProver = proverMode === "alpha_local" || proverMode === "alpha_controlled_service"
  const proverLabel = isLocalProver ? "Local browser session" : "Alpha demo prover"
  const verifierContract = demo?.snapshot?.contracts?.collateralSufficiencyVerifier
  const latestLedger = demo?.snapshot?.stellar?.rpc?.latestLedgerSequence
  const isLive = demo?.source === "live"
  const networkName = shortNetworkName(demo?.snapshot?.network?.networkPassphrase)
  const assetMeta = COLLATERAL_ASSETS.find((a) => a.id === selectedAsset)!

  async function requestQuote() {
    setQuoting(true)
    setQuoteError(null)
    try {
      // cXAUm has no deployed contract yet — show reference policy terms
      // instead of calling the live quote endpoint. Swap this branch out
      // once CXAUM_CONTRACT_ID is configured.
      if (!assetMeta.wired) {
        const feeAmount = String(Math.round((Number(amountInput) * REFERENCE_FEE_BPS) / 10000))
        setQuote({
          id: `ref_${Date.now().toString(16)}`,
          account: alpha ?? "unconfigured",
          anchorTransactionId: null,
          collateralToken: "not_deployed",
          requestedCreditAmount: amountInput,
          tenorDays: tenorInput,
          participantApproved: true,
          oraclePriceE7: "10000000",
          oracleUpdatedLedger: null,
          haircutBps: assetMeta.haircutBps,
          maxTenorDays: assetMeta.maxTenorDays,
          feeBps: REFERENCE_FEE_BPS,
          feeAmount,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          source: "reference",
        })
        setPhase("quoted")
        return
      }

      const resolved = await resolveDemoAlphaAccount(API, alpha)
      const quoteAccount = resolved.account
      const anchorTransactionId =
        demo?.snapshot?.product?.latestSep31Transaction?.id ?? resolved.anchorTransactionId

      if (!quoteAccount || !collateralToken) throw new Error("Alpha account or collateral token not configured")
      const res = await fetch(`${API}/api/prefunding/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: quoteAccount,
          anchorTransactionId,
          collateralToken,
          requestedCreditAmount: amountInput,
          tenorDays: tenorInput,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Quote request failed")
      setQuote({ ...body, source: "chain" } as PrefundingQuote)
      setPhase("quoted")
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : String(e))
    } finally {
      setQuoting(false)
    }
  }

  function runProofSequence() {
    void openCreditWithProof()
  }

  async function openCreditWithProof() {
    if (!quote || quote.source !== "chain") return
    setProofError(null)
    setPhase("proving")
    setStage(1)

    // While demo-flow/open runs server-side (fixture → real Noir proof →
    // on-chain open_credit), poll the actual proof job so the pipeline
    // stages reflect real progress instead of timers.
    const startJobId = demo?.snapshot?.product?.latestProofJobId ?? null
    const poll = setInterval(async () => {
      try {
        const stateRes = await fetch(`${API}/api/demo/state`)
        if (!stateRes.ok) return
        const stateJson = (await stateRes.json()) as DemoState
        const jobId = stateJson.snapshot?.product?.latestProofJobId
        if (!jobId || jobId === startJobId) return
        setStage((s) => (s < 2 ? 2 : s))
        const jobRes = await fetch(`${API}/api/proof/${jobId}`)
        if (!jobRes.ok) return
        const job = (await jobRes.json()) as { status: string }
        if (job.status === "succeeded") setStage((s) => (s < 3 ? 3 : s))
      } catch { /* keep polling */ }
    }, 2000)

    try {
      const res = await fetch(`${API}/api/demo-flow/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteId: quote.id,
          anchorTransactionId: quote.anchorTransactionId ?? demo?.snapshot?.product?.latestSep31Transaction?.id,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Credit open failed")
      setStage(4)
      setOpenResult(body as DemoFlowOpenResult)
      setPhase("verified")
      setDrawerOpen(true)
    } catch (e) {
      setProofError(e instanceof Error ? e.message : String(e))
      setPhase("failed")
      setStage(0)
    } finally {
      clearInterval(poll)
    }
  }

  const eligible = quote?.participantApproved ?? false
  const haircutBps = quote?.haircutBps ?? assetMeta.haircutBps
  const feeAmount = quote?.feeAmount ?? "0"
  const requestedAmount = quote?.requestedCreditAmount ?? amountInput
  const tenorDays = quote?.tenorDays ?? tenorInput

  const proofProgressPct = phase === "verified" ? 100 : (stage / 4) * 100
  const proof = openResult?.state.proof
  const openTx = openResult?.state.open
  const positionId = openResult?.state.positionId

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
              Private Prefunding Request
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
              <span>Proof</span>
              <StatusBadge
                label={phase === "verified" ? "verified" : phase === "proving" ? "generating" : "not started"}
                variant={phase === "verified" ? "success" : phase === "proving" ? "warning" : "neutral"}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 overflow-hidden">
        <div className="max-w-[1060px] mx-auto px-6 h-full py-6 grid grid-cols-[1fr_320px] gap-5 items-start">

          {/* ── Left column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Identity */}
            <div className="flex items-start justify-between flex-shrink-0">
              <div>
                <Link
                  href="/vault"
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-[#a8a29e] hover:text-[#605A57] tracking-[0.1em] uppercase mb-1 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" /> Collateral Vault
                </Link>
                <h1 className="text-[26px] font-serif text-[#37322F] leading-tight">
                  Private Prefunding Request
                </h1>
                <p className="text-[12px] text-[#8a8480] mt-0.5">Alpha Remit · {selectedAsset} collateral</p>
              </div>
              {phase !== "input" && (
                <StatusBadge label={eligible ? "Eligible" : "Ineligible"} variant={eligible ? "success" : "danger"} />
              )}
            </div>

            {/* Main card — grows to fill */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl flex flex-col overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">

              {/* Card header */}
              <div className="flex-shrink-0 px-5 py-3.5 border-b border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[rgba(55,50,47,0.06)] flex items-center justify-center flex-shrink-0">
                    <Banknote className="w-3.5 h-3.5 text-[#605A57]" />
                  </div>
                  {quote ? (
                    <IdBadge tag={quote.source === "reference" ? "REFERENCE" : "QUOTE"} value={shortQuoteId(quote.id)} />
                  ) : (
                    <p className="text-[11px] font-bold text-[#8a8480] tracking-[0.1em] uppercase">
                      Configure draw
                    </p>
                  )}
                </div>
                {phase !== "input" && (
                  <button
                    onClick={() => { setPhase("input"); setQuote(null) }}
                    disabled={phase === "proving" || phase === "verified"}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8a8480] hover:text-[#37322F] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                )}
              </div>

              {/* Body */}
              <div className="flex-1 px-5 py-1 overflow-hidden">
                {initLoading ? (
                  <div className="flex flex-col gap-0 pt-2">
                    {[1,2,3,4,5].map(i => (
                      <div key={i} className="flex justify-between py-[9px] border-b border-[rgba(55,50,47,0.07)]">
                        <div className="h-3 w-24 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                      </div>
                    ))}
                  </div>
                ) : phase === "input" ? (
                  <div className="pt-2 flex flex-col gap-5">
                    <div>
                      <SectionLabel>Request</SectionLabel>
                      <div className="flex flex-col gap-4">
                        {/* Draw amount input — hero style with USDC logo */}
                        <div>
                          <label className="text-[11px] font-medium text-[#8a8480] mb-1.5 block">Requested draw</label>
                          <div className="flex items-center bg-white border border-[rgba(55,50,47,0.14)] rounded-xl px-4 py-3 focus-within:border-[rgba(55,50,47,0.35)] transition-colors">
                            <UsdcIcon size={24} />
                            <input
                              type="text"
                              inputMode="numeric"
                              value={amountInput}
                              onChange={(e) => setAmountInput(e.target.value.replace(/[^0-9]/g, ""))}
                              className="flex-1 min-w-0 bg-transparent ml-3 text-[24px] font-semibold text-[#37322F] font-mono outline-none placeholder:text-[#c4bfbb]"
                              placeholder="50000"
                            />
                            <span className="text-[12px] font-medium text-[#a8a29e] flex-shrink-0">cUSDC</span>
                          </div>
                        </div>

                        {/* Tenor selector */}
                        <div>
                          <label className="text-[11px] font-medium text-[#8a8480] mb-1.5 block">Tenor</label>
                          <div className="flex gap-1.5">
                            {[1, 2, 3, 4, 5].map((d) => (
                              <button
                                key={d}
                                onClick={() => setTenorInput(d)}
                                className={cn(
                                  "flex-1 py-2 rounded-lg text-[13px] font-medium border transition-all",
                                  tenorInput === d
                                    ? "bg-[#37322F] text-white border-[#37322F]"
                                    : "bg-white text-[#605A57] border-[rgba(55,50,47,0.14)] hover:border-[rgba(55,50,47,0.30)]"
                                )}
                              >
                                {d}d
                              </button>
                            ))}
                          </div>
                          <p className="text-[11px] text-[#a8a29e] mt-2 leading-relaxed">
                            {tenorInput}-day tenor · due {dueDate(tenorInput)} · within cTBill&apos;s 5-day policy limit
                          </p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <SectionLabel>Collateral</SectionLabel>
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

                    {/* Live preview strip — fills the remaining space with real feedback */}
                    {Number(amountInput) > 0 && (
                      <div className="flex items-center justify-between bg-[rgba(55,50,47,0.03)] border border-dashed border-[rgba(55,50,47,0.16)] rounded-xl px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-3.5 h-3.5 text-[#a8a29e]" />
                          <span className="text-[11px] text-[#8a8480] font-medium">Live preview</span>
                        </div>
                        <span className="text-[12px] text-[#605A57] font-medium">
                          ~{formatAmount(String(Math.round((Number(amountInput) * REFERENCE_FEE_BPS) / 10000)))} cUSDC fee · due {dueDate(tenorInput)}
                        </span>
                      </div>
                    )}

                    {quoteError && (
                      <div className="flex items-start gap-2 bg-[#9a2c1a]/06 border border-[#9a2c1a]/20 rounded-xl px-3.5 py-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-[#9a2c1a] flex-shrink-0 mt-0.5" />
                        <p className="text-[11px] text-[#9a2c1a] leading-relaxed">{quoteError}</p>
                      </div>
                    )}
                    {proofError && (
                      <div className="flex items-start gap-2 bg-[#9a2c1a]/06 border border-[#9a2c1a]/20 rounded-xl px-3.5 py-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-[#9a2c1a] flex-shrink-0 mt-0.5" />
                        <p className="text-[11px] text-[#9a2c1a] leading-relaxed">{proofError}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <MetricRow
                      label="Requested draw"
                      badge={
                        <span className="flex items-center gap-1.5 text-[16px] text-[#37322F] font-semibold">
                          <UsdcIcon size={16} />
                          {formatAmount(requestedAmount)} cUSDC
                        </span>
                      }
                    />
                    <MetricRow label="Tenor" value={`${tenorDays} days`} />
                    <MetricRow label="Collateral asset" value={selectedAsset} mono />
                    <MetricRow label="Haircut" value={`${(haircutBps / 100).toFixed(0)}%`} />
                    <MetricRow label="Estimated fee" value={`${formatAmount(feeAmount)} cUSDC`} />
                    <MetricRow label="Due date" value={dueDate(tenorDays)} />
                    <MetricRow label="Eligibility" badge={<StatusBadge label={eligible ? "Passed" : "Failed"} variant={eligible ? "success" : "danger"} />} />
                  </div>
                )}
              </div>

              {/* Card footer */}
              <div className="flex-shrink-0 px-5 py-4 border-t border-[rgba(55,50,47,0.08)] flex flex-col gap-3">
                {phase === "quoted" && (
                  <p className="text-[11px] text-[#8a8480] leading-relaxed">
                    Alpha proves the private {selectedAsset} position covers the requested cUSDC draw after haircut.
                    Nyx verifies the proof without revealing reserve size.
                    {quote?.source === "reference" && " Haircut and tenor shown are reference policy terms — the cXAUm contract is not yet deployed."}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] text-[#a8a29e] max-w-[300px] leading-relaxed">
                    {phase === "input" && "Quote terms are read live from CollateralPolicyRegistry and OracleAdapter."}
                    {phase === "quoted" && "Proof system: Noir + UltraHonk"}
                    {phase === "proving" && "Do not close this tab while the proof is generating."}
                    {phase === "verified" && "Position opened. Collateral commitment locked on-chain."}
                    {phase === "failed" && "Backend did not open the position. Review the error and retry after fixing artifacts/config."}
                  </p>

                  {phase === "input" && (
                    <button
                      onClick={requestQuote}
                      disabled={quoting || !amountInput}
                      className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                        shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                        hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                        disabled:opacity-50 disabled:hover:scale-100
                        transition-all duration-200"
                    >
                      <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                      {quoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      {quoting ? "Reading policy..." : "Get quote"}
                      {!quoting && <ArrowRight className="w-3.5 h-3.5" />}
                    </button>
                  )}

                  {phase === "quoted" && (
                    <button
                      onClick={runProofSequence}
                      disabled={!eligible || quote?.source !== "chain"}
                      className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                        shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                        hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                        disabled:opacity-50 disabled:hover:scale-100
                        transition-all duration-200"
                    >
                      <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                      Verify private collateral
                      <ShieldCheck className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {phase === "proving" && (
                    <button
                      disabled
                      className="inline-flex items-center gap-2 bg-[#37322F]/60 text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0 cursor-not-allowed"
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Verifying...
                    </button>
                  )}

                  {phase === "verified" && (
                    <Link
                      href={`/draw?amount=${requestedAmount}&tenor=${tenorDays}&fee=${feeAmount}&collateral=${selectedAsset}&positionId=${positionId ?? ""}`}
                      className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                        shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                        hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                        transition-all duration-200"
                    >
                      <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                      Continue to draw
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Proof status hero */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-2.5">
                Proof status
              </p>
              <div className="flex items-center gap-2 mb-3">
                {phase === "verified" ? (
                  <CircleCheck className="w-5 h-5 text-[#1a6042]" />
                ) : phase === "proving" ? (
                  <Loader2 className="w-5 h-5 text-[#92400e] animate-spin" />
                ) : (
                  <Lock className="w-5 h-5 text-[#a8a29e]" />
                )}
                <span className={cn(
                  "text-[16px] font-serif leading-none",
                  phase === "verified" ? "text-[#1a6042]" : phase === "proving" ? "text-[#92400e]" : "text-[#a8a29e]"
                )}>
                  {phase === "verified" ? "Verified" : phase === "failed" ? "Failed" : phase === "proving" ? PROOF_STAGES[Math.max(0, stage - 1)] : "Not started"}
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-1.5 rounded-full bg-[rgba(55,50,47,0.08)] overflow-hidden mb-3">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-700 ease-out",
                    phase === "verified" ? "bg-[#1a6042]" : "bg-[#92400e]"
                  )}
                  style={{ width: `${proofProgressPct}%` }}
                />
              </div>

              <div className="w-full h-[1px] bg-[rgba(55,50,47,0.08)] mb-3" />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#a8a29e] flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" /> Prover
                </span>
                <span className="text-[11px] text-[#37322F] font-medium">{proverLabel}</span>
              </div>
            </div>

            {/* Proof pipeline stepper — grows */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-3">
                Proof pipeline
              </p>
              <div className="flex flex-col">
                {PROOF_STAGES.map((label, i) => {
                  const stepNum = i + 1
                  const isDone = phase === "verified" || (phase === "proving" && stage > stepNum)
                  const isCurrent = phase === "proving" && stage === stepNum
                  return (
                    <div key={label} className="flex items-center gap-3 py-2.5 relative">
                      {i < PROOF_STAGES.length - 1 && (
                        <div className="absolute left-[8px] top-[26px] w-[1px] h-[calc(100%-10px)] bg-[rgba(55,50,47,0.10)]" />
                      )}
                      <div className={cn(
                        "w-[17px] h-[17px] rounded-full border flex-shrink-0 flex items-center justify-center z-10",
                        isDone && "bg-[#37322F] border-[#37322F]",
                        isCurrent && "bg-[#92400e]/10 border-[#92400e]",
                        !isDone && !isCurrent && "bg-[#F7F5F3] border-[rgba(55,50,47,0.20)]"
                      )}>
                        {isDone && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                        {isCurrent && <Loader2 className="w-2.5 h-2.5 text-[#92400e] animate-spin" />}
                      </div>
                      <span className={cn(
                        "text-[12px] font-medium",
                        isDone ? "text-[#37322F]" : isCurrent ? "text-[#92400e]" : "text-[#c4bfbb]"
                      )}>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Verification drawer */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                disabled={phase !== "verified"}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-[rgba(55,50,47,0.02)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase">
                  Verification details
                </span>
                {drawerOpen && phase === "verified"
                  ? <ChevronUp className="w-3 h-3 text-[#a8a29e]" />
                  : <ChevronDown className="w-3 h-3 text-[#a8a29e]" />
                }
              </button>
              {drawerOpen && phase === "verified" && (
                <div className="border-t border-[rgba(55,50,47,0.08)] px-4 py-3 flex flex-col gap-2.5 max-h-[45vh] overflow-y-auto">
                  {[
                    { label: "Proof system",        value: "Noir + UltraHonk" },
                    { label: "Verifier contract",   value: shortAddr(proof?.verifierContractId ?? verifierContract) },
                    { label: "Proof job",           value: proof?.jobId ?? "Pending" },
                    {
                      label: "Proof",
                      value: proof?.proofHex
                        ? `${shortAddr(proof.proofHex)} · ${Math.round(proof.proofHex.replace(/^0x/, "").length / 2)} bytes`
                        : "Pending",
                    },
                    { label: "Position nullifier",  value: shortAddr(nullifierFromPublicInputs(proof?.publicInputsHex)) },
                    { label: "Public inputs",       value: shortAddr(proof?.publicInputsHex) },
                    { label: "Position ID",         value: shortAddr(positionId) },
                    { label: "Open tx hash",        value: shortAddr(openTx?.txHash) },
                    { label: "Opened ledger",       value: openTx?.ledger ? String(openTx.ledger) : latestLedger ? String(latestLedger) : "Pending sync" },
                  ].map(row => (
                    <div key={row.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-[#a8a29e] font-medium">{row.label}</span>
                      <span className="text-[11px] font-mono text-[#605A57] break-all">{row.value}</span>
                    </div>
                  ))}
                  {openTx?.txHash && (
                    <a
                      href={explorerTxUrl(demo?.snapshot?.network?.networkPassphrase, openTx.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-[#1a6042] hover:text-[#14503a] transition-colors"
                    >
                      View transaction on Stellar Expert <ArrowUpRight className="w-3 h-3" />
                    </a>
                  )}
                  <a
                    href={`${API}/api/proof/${proof?.jobId ?? ""}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] text-[#605A57] hover:text-[#37322F] transition-colors font-medium"
                  >
                    View full proof artifact <ArrowUpRight className="w-3 h-3" />
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

export default function CreditPage() {
  return (
    <Suspense fallback={null}>
      <CreditPageInner />
    </Suspense>
  )
}
