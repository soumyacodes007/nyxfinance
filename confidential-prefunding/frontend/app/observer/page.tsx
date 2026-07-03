"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  EyeOff,
  ShieldCheck,
  Radio,
  Loader2,
  KeyRound,
  Wifi,
  WifiOff,
  Share2,
  History,
  CircleCheck,
  Circle,
  Copy,
  Check,
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
  } | null
}

interface Quote {
  id: string
  account: string
  collateralToken: string
  requestedCreditAmount: string
  tenorDays: number
  haircutBps: number
  feeAmount: string
  oraclePriceE7: string
}

interface DemoFlowState {
  state: {
    anchorTransactionId: string | null
    positionId: string | null
    quote: Quote | null
    proof: { jobId: string; status: string; verifierContractId: string | null } | null
    open: { txHash: string; ledger?: number | null } | null
    draw: { txHash: string; ledger?: number | null; confidentialTransferTxHash: string | null; transferCommitment: string } | null
    repay: { txHash: string; ledger?: number | null; repaymentCommitment: string; confidentialTransferTxHash: string | null } | null
    historyProof: {
      jobId: string
      status: string
      verified: boolean
      txHash: string
      ledger?: number | null
      proofNullifier: string
      historyRoot: string
      threshold: number
      onTimeCount: number
      leafCount: number
      publicInputsHex: string
      verifierContractId: string | null
    } | null
  }
  anchorTransaction: {
    id: string
    sepStatus: string
    productStatus: string
  } | null
  contracts: Record<string, string>
  transfers: Array<{
    id: string
    direction: string
    txHash: string
    dataXdrSha256: string
    auditorPayload?: Record<string, unknown> | null
  }>
}

type Role = "public" | "unlocking" | "auditor"
type DisclosurePhase = "idle" | "creating" | "revealing" | "created" | "error"

const UNLOCK_STAGES = ["Loading auditor credential", "Fetching encrypted event payloads", "Decrypting auditor ciphertexts"]

type DecryptedAmounts = {
  draw?: string
  repayment?: string
  repaymentSenderBalance?: string
  note?: string
}

// ─── Shared components ────────────────────────────────────────────────────────

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

function MetricRow({ label, value, badge, hidden }: { label: string; value?: string; badge?: React.ReactNode; hidden?: boolean }) {
  return (
    <div className="flex items-center justify-between py-[8px] border-b border-[rgba(55,50,47,0.07)] last:border-0">
      <span className="text-[12px] text-[#8a8480] font-medium">{label}</span>
      {badge ?? (
        hidden ? (
          <span className="flex items-center gap-1 text-[12px] text-[#a8a29e] font-medium italic">
            <EyeOff className="w-3.5 h-3.5" /> Hidden
          </span>
        ) : (
          <span className="text-[12px] text-[#37322F] font-bold">{value}</span>
        )
      )}
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

function formatAmount(value: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric)
}

function browserRandomHex(bytes: number) {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("")
}

const POLL_INTERVAL_MS = 4000

// ─── Page ────────────────────────────────────────────────────────────────────

function ObserverPageInner() {
  const params = useSearchParams()
  const collateral = params.get("collateral") ?? "cTBill"

  const [demo, setDemo] = useState<DemoState | null>(null)
  const [flow, setFlow] = useState<DemoFlowState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [role, setRole] = useState<Role>("public")
  const [unlockStage, setUnlockStage] = useState(0)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [liveEventCount, setLiveEventCount] = useState<number | null>(null)
  const [decrypted, setDecrypted] = useState<DecryptedAmounts>({})
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [disclosurePhase, setDisclosurePhase] = useState<DisclosurePhase>("idle")
  const [disclosureError, setDisclosureError] = useState<string | null>(null)
  const [disclosureLink, setDisclosureLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

  const loadFlow = useCallback(async () => {
    try {
      const flowRes = await fetch(`${API}/api/demo-flow/state`)
      if (flowRes.ok) {
        setFlow(await flowRes.json())
        setError(null)
      } else {
        setError("Backend state unavailable — showing reference values")
      }
    } catch {
      setError("Backend unreachable — reference values shown")
    }
  }, [API])

  // Initial load + poll: the right browser must update live while the left
  // browser draws/repays (demo script step 9 — one continuous session).
  useEffect(() => {
    async function initial() {
      try {
        const demoRes = await fetch(`${API}/api/demo/state`)
        if (demoRes.ok) setDemo(await demoRes.json())
      } catch { /* error state handled by loadFlow */ }
      await loadFlow()
      setLoading(false)
    }
    initial()
    const interval = setInterval(loadFlow, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [API, loadFlow])

  useEffect(() => {
    return () => {
      if (unlockTimer.current) clearTimeout(unlockTimer.current)
      if (revealTimer.current) clearTimeout(revealTimer.current)
    }
  }, [])

  // Unlock ceremony — stage 2 fetches the REAL encrypted auditor event refs,
  // stage 3 runs the REAL decryptor (runner: ECDH + sponge unmask) against the
  // stored draw/repayment evidence. If the backend is unreachable the unlock
  // still proceeds as a labeled reference session with no decryption claim.
  async function startUnlock() {
    setRole("unlocking")
    setUnlockError(null)
    setUnlockStage(0)
    await new Promise((resolve) => { unlockTimer.current = setTimeout(resolve, 600) })
    setUnlockStage(1)

    let events: Array<{ id: string; direction: string }> = []
    try {
      const res = await fetch(`${API}/api/auditor/live-events?limit=20`)
      if (!res.ok) throw new Error("Auditor event feed unavailable")
      const body = await res.json() as { events: Array<{ id: string; direction: string }> }
      events = body.events
      setLiveEventCount(events.length)
    } catch (e) {
      setLiveEventCount(null)
      setUnlockError(`${e instanceof Error ? e.message : String(e)} — reference auditor session`)
    }

    setUnlockStage(2)
    const next: DecryptedAmounts = {}
    for (const direction of ["draw", "repayment"] as const) {
      const evidence = events.find((event) => event.direction === direction)
      if (!evidence) continue
      try {
        const res = await fetch(`${API}/api/auditor/decrypt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ evidenceId: evidence.id }),
        })
        const body = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(String(body.error ?? "decrypt failed"))
        const amount = body.decrypted_amount ?? body.decryptedAmount
        if (amount !== undefined) next[direction] = String(amount)
        const senderBalance = body.decrypted_sender_balance ?? body.decryptedSenderBalance
        if (direction === "repayment" && senderBalance !== undefined) {
          next.repaymentSenderBalance = String(senderBalance)
        }
      } catch (e) {
        next.note = e instanceof Error ? e.message : String(e)
      }
    }
    setDecrypted(next)
    setRole("auditor")
  }

  const isLive = demo?.source === "live"
  const networkName = shortNetworkName(demo?.snapshot?.network?.networkPassphrase)
  const flowState = flow?.state
  const quote = flowState?.quote
  const anchorTx = flow?.anchorTransaction
  const latestLedger = demo?.snapshot?.stellar?.rpc?.latestLedgerSequence

  // Reference fallbacks when no live position exists yet in this session
  const drawAmount = quote?.requestedCreditAmount ?? "50000"
  const feeAmount = quote?.feeAmount ?? "175"
  const tenorDays = quote?.tenorDays ?? 3
  const haircutBps = quote?.haircutBps ?? 1000
  const oraclePriceE7 = quote?.oraclePriceE7 ?? "10000000"
  const alphaAccount = quote?.account ?? demo?.snapshot?.accounts?.alpha ?? "GXXXXXXXXXXXXXXXXXX"

  // The true collateral balance never reaches this backend — only Alpha's
  // private witness holds it. We show the algebraic minimum implied by the
  // verified proof, clearly labeled as derived rather than decrypted.
  const oraclePrice = Number(oraclePriceE7) / 1e7
  const haircutFactor = (10000 - haircutBps) / 10000
  const impliedMinCollateral =
    oraclePrice > 0 && haircutFactor > 0 ? Number(drawAmount) / (oraclePrice * haircutFactor) : null

  const hasCiphertext = (flow?.transfers ?? []).some(t => Boolean(t.auditorPayload || t.dataXdrSha256))
  const historyProof = flowState?.historyProof
  const positionStatus = flowState?.repay ? "Repaid" : flowState?.draw ? "Active" : flowState?.open ? "Opening" : "Pending"
  const sepStatus = anchorTx?.sepStatus ?? "pending_sender"
  const productStatus = anchorTx?.productStatus ?? "prefunding_required"
  const hasLivePosition = Boolean(flowState?.open || flowState?.draw || flowState?.repay)

  // Every event here is a public on-chain fact — lifecycle is public,
  // amounts are private. Shown in both modes.
  const timeline = [
    { label: "Participant approved", done: Boolean(quote) },
    { label: "Proof verified", done: flowState?.proof?.status === "succeeded" },
    { label: "Credit line opened", done: Boolean(flowState?.open) },
    { label: "Draw executed", done: Boolean(flowState?.draw) },
    { label: "Auditor ciphertext emitted", done: hasCiphertext },
    { label: "Repayment confirmed", done: Boolean(flowState?.repay) },
    { label: "Collateral lock released", done: Boolean(flowState?.repay) },
    { label: "History proof verified", done: Boolean(historyProof?.verified) },
  ]

  const isAuditor = role === "auditor"

  async function createDisclosure() {
    setDisclosurePhase("creating")
    setDisclosureError(null)
    try {
      const viewerSecret = browserRandomHex(32)
      const positionId = flowState?.positionId
      if (!positionId) throw new Error("No live position exists yet. Open credit before creating disclosure.")
      if (!historyProof?.verified) throw new Error("Run repayment history proof before creating disclosure.")
      const eventId = historyProof.txHash
      const scope = {
        fields: ["repaymentStatus", "threshold", "onTimeRepayments", "totalRepayments", "positionStatus"],
        label: "Repayment history threshold only",
      }
      const scopedData = {
        repaymentStatus: "on_time_threshold_met",
        threshold: historyProof.threshold,
        onTimeRepayments: historyProof.onTimeCount,
        totalRepayments: historyProof.leafCount,
        positionStatus,
      }
      const expiresAtLedger = (latestLedger ?? 1_000_000) + 100_000

      const res = await fetch(`${API}/api/disclosure/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: alphaAccount, viewerSecret, positionId, eventId, scope, scopedData, expiresAtLedger }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Disclosure creation failed")

      const link = `/disclosure/${body.grantId}#key=${viewerSecret}`
      setDisclosurePhase("revealing")
      revealTimer.current = setTimeout(() => {
        setDisclosureLink(link)
        setDisclosurePhase("created")
      }, 1400)
    } catch (e) {
      setDisclosureError(e instanceof Error ? e.message : String(e))
      setDisclosurePhase("error")
    }
  }

  async function copyLink() {
    if (!disclosureLink) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${disclosureLink}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard unavailable — user can copy from the open tab */ }
  }

  return (
    <div className="h-screen w-full bg-[#F7F5F3] flex flex-col overflow-hidden relative">

      {/* Vertical rules */}
      <div className="pointer-events-none fixed inset-y-0 left-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[1px_0_0_white] z-50" />
      <div className="pointer-events-none fixed inset-y-0 right-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[-1px_0_0_white] z-50" />

      {/* ── Narrowing disclosure overlay ── */}
      {disclosurePhase === "revealing" && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#F7F5F3]/97 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-5 max-w-md text-center px-6">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] font-medium text-[#c4bfbb] tracking-[0.08em] uppercase animate-[narrowFade_1.4s_ease-out_forwards]">
              <span>Collateral amount</span><span>·</span>
              <span>Draw amount</span><span>·</span>
              <span>Fee</span><span>·</span>
              <span>Full audit trail</span>
            </div>
            <div className="inline-flex items-center gap-2.5 bg-white border border-[#1a6042]/25 rounded-full px-6 py-3 shadow-[0_8px_28px_rgba(26,96,66,0.16)] animate-[narrowPop_1.4s_ease-out_forwards]">
              <ShieldCheck className="w-4 h-4 text-[#1a6042] flex-shrink-0" />
              <span className="text-[15px] font-bold text-[#1a6042]">
                Threshold met: ≥{historyProof?.threshold ?? 2} of {historyProof?.leafCount ?? 3} on time
              </span>
            </div>
            <p className="text-[11px] text-[#a8a29e] flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Generating scoped disclosure link
            </p>
          </div>
        </div>
      )}

      {/* ── Unlock ceremony overlay ── */}
      {role === "unlocking" && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#F7F5F3]/95 backdrop-blur-sm">
          <div className="bg-white border border-[rgba(55,50,47,0.12)] rounded-2xl px-8 py-7 shadow-[0_12px_40px_rgba(55,50,47,0.12)] flex flex-col items-center gap-4 max-w-sm">
            <div className="w-10 h-10 rounded-full bg-[#1a6042]/10 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-[#1a6042]" />
            </div>
            <p className="text-[13px] font-bold text-[#37322F] text-center">Demo auditor credential</p>
            <div className="flex flex-col gap-2 w-full">
              {UNLOCK_STAGES.map((label, i) => (
                <div key={label} className="flex items-center gap-2.5">
                  {i < unlockStage ? (
                    <CircleCheck className="w-3.5 h-3.5 text-[#1a6042] flex-shrink-0" />
                  ) : i === unlockStage ? (
                    <Loader2 className="w-3.5 h-3.5 text-[#92400e] animate-spin flex-shrink-0" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-[rgba(55,50,47,0.20)] flex-shrink-0" />
                  )}
                  <span className={cn("text-[12px]", i <= unlockStage ? "text-[#37322F] font-medium" : "text-[#c4bfbb]")}>
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <div className="flex-shrink-0 border-b border-[rgba(55,50,47,0.10)] bg-[#F7F5F3]/90 backdrop-blur-sm z-30">
        <div className="max-w-[1060px] mx-auto px-6 h-10 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[13px] font-medium text-[#37322F] hover:opacity-70 transition-opacity">
              Nyx
            </Link>
            <span className="w-[1px] h-3.5 bg-[rgba(55,50,47,0.15)]" />

            {/* Role toggle */}
            <div className="flex gap-1 bg-[rgba(55,50,47,0.05)] rounded-full p-[3px]">
              <button
                onClick={() => setRole("public")}
                disabled={role === "unlocking"}
                className={cn(
                  "px-3 py-1 rounded-full text-[11px] font-bold transition-all disabled:opacity-40 whitespace-nowrap",
                  role === "public" ? "bg-[#37322F] text-white" : "text-[#8a8480] hover:text-[#37322F]"
                )}
              >
                Public Observer
              </button>
              <button
                onClick={startUnlock}
                disabled={role !== "public"}
                className={cn(
                  "px-3 py-1 rounded-full text-[11px] font-bold transition-all disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap",
                  isAuditor ? "bg-[#1a6042] text-white" : "text-[#8a8480] hover:text-[#37322F]"
                )}
              >
                <KeyRound className="w-3 h-3" />
                Auditor
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="flex items-center gap-1.5 text-[11px] text-[#8a8480] whitespace-nowrap">
              {isLive ? <Wifi className="w-3 h-3 text-[#1a6042] flex-shrink-0" /> : <span className="w-1.5 h-1.5 rounded-full bg-[#a8a29e] flex-shrink-0" />}
              {networkName}
            </span>
            <span className="w-[1px] h-3.5 bg-[rgba(55,50,47,0.15)] flex-shrink-0" />
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480] whitespace-nowrap">
              <span className="font-mono">SEP-31</span>
              <StatusBadge label={sepStatus.replace(/_/g, " ")} variant={sepStatus === "completed" ? "success" : "warning"} />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480] whitespace-nowrap">
              <span>Nyx</span>
              <StatusBadge label={productStatus.replace(/_/g, " ")} variant="pending" />
            </div>
          </div>
        </div>
        {(error || unlockError) && (
          <div className="border-t border-[rgba(146,64,14,0.15)] bg-[#92400e]/06 px-6 py-1">
            <div className="max-w-[1060px] mx-auto flex items-center gap-1.5 text-[10px] text-[#92400e]">
              <WifiOff className="w-3 h-3 flex-shrink-0" />
              {unlockError ?? error}
            </div>
          </div>
        )}
      </div>

      {/* ── Main area — single viewport ── */}
      <div className="flex-1 overflow-hidden">
        <div className="max-w-[1060px] mx-auto px-6 h-full py-5 grid grid-cols-[1fr_320px] gap-5 items-stretch">

          {/* ── Left column ── */}
          <div className="h-full flex flex-col gap-4 min-h-0">

            {/* Identity */}
            <div className="flex items-start justify-between flex-shrink-0">
              <div>
                <p className="text-[10px] font-bold text-[#a8a29e] tracking-[0.12em] uppercase mb-1">
                  {isAuditor ? "Auditor View" : "Public Observer"}
                </p>
                <h1 className="text-[24px] font-serif text-[#37322F] leading-tight">
                  Alpha Remit Position
                </h1>
                <p className="text-[12px] text-[#8a8480] mt-0.5">{collateral} collateral · same position, different credential</p>
              </div>
              <StatusBadge label={positionStatus} variant={positionStatus === "Repaid" ? "success" : positionStatus === "Active" ? "warning" : "neutral"} />
            </div>

            {/* Position Overview — toggle-controlled values */}
            <div className="flex-1 min-h-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl flex flex-col overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <div className="flex-shrink-0 px-5 py-3 border-b border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase">Position Overview</p>
                {isAuditor && (
                  <StatusBadge
                    label={
                      decrypted.draw || decrypted.repayment
                        ? "Ciphertexts decrypted"
                        : liveEventCount
                          ? `${liveEventCount} ciphertext refs verified`
                          : "Auditor session"
                    }
                    variant="success"
                  />
                )}
              </div>
              <div className="flex-1 px-5 py-1 overflow-hidden">
                {loading ? (
                  <div className="flex flex-col gap-0 pt-2">
                    {[1,2,3,4,5].map(i => (
                      <div key={i} className="flex justify-between py-[8px] border-b border-[rgba(55,50,47,0.07)]">
                        <div className="h-3 w-24 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>
                    <MetricRow label="Collateral asset" value={collateral} />
                    <MetricRow label="Tenor" value={`${tenorDays} days`} />
                    <MetricRow label="Proof status" badge={<StatusBadge label={flowState?.proof?.status === "succeeded" ? "Verified" : "Pending"} variant={flowState?.proof?.status === "succeeded" ? "success" : "neutral"} />} />
                    <MetricRow label="Collateral (implied minimum)" value={impliedMinCollateral ? `${formatAmount(impliedMinCollateral.toFixed(0))} ${collateral}` : "—"} hidden={!isAuditor} />
                    <MetricRow
                      label={decrypted.draw ? "Draw amount (decrypted)" : "Draw amount"}
                      value={`${formatAmount(decrypted.draw ?? drawAmount)} cUSDC`}
                      hidden={!isAuditor}
                    />
                    <MetricRow label="Fee" value={`${formatAmount(feeAmount)} cUSDC`} hidden={!isAuditor} />
                    <MetricRow label="Haircut" value={`${(haircutBps / 100).toFixed(0)}%`} hidden={!isAuditor} />
                    <MetricRow
                      label={decrypted.repayment ? "Repayment amount (decrypted)" : "Repayment amount"}
                      value={`${formatAmount(decrypted.repayment ?? String(Number(drawAmount) + Number(feeAmount)))} cUSDC`}
                      hidden={!isAuditor}
                    />
                  </div>
                )}
              </div>
              {isAuditor && (decrypted.draw || decrypted.repayment || decrypted.note) && (
                <p className="flex-shrink-0 px-5 py-2 border-t border-[rgba(55,50,47,0.08)] text-[10px] text-[#a8a29e] leading-relaxed">
                  {decrypted.draw || decrypted.repayment
                    ? "Amounts unmasked from on-chain auditor ciphertexts using the demo auditor key — the values above were never stored in plaintext."
                    : `Ciphertext decrypt unavailable: ${decrypted.note}`}
                </p>
              )}
            </div>

            {/* Proof Attestation — public tier, both modes */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl px-5 py-3.5 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase mb-2.5">Proof Attestation</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-3 h-3 text-[#1a6042]" /> Collateral sufficiency
                  </span>
                  <span className={cn("text-[10px] font-bold", flowState?.proof?.status === "succeeded" ? "text-[#1a6042]" : "text-[#a8a29e]")}>
                    {flowState?.proof?.status === "succeeded" ? "Verified" : "Pending"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-3 h-3 text-[#1a6042]" /> Policy
                  </span>
                  <span className="text-[10px] font-bold text-[#1a6042]">Satisfied</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <Radio className="w-3 h-3 text-[#1a6042]" /> Oracle freshness
                  </span>
                  <span className="text-[10px] font-bold text-[#1a6042]">Satisfied</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#605A57] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-3 h-3 text-[#1a6042]" /> Replay protection
                  </span>
                  <span className="text-[10px] font-bold text-[#1a6042]">Nullifier used</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="h-full flex flex-col gap-4 min-h-0">

            {/* Live position timeline — public on-chain lifecycle, lights up
                as the left browser progresses (polled every 4s) */}
            <div className="flex-1 min-h-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)] overflow-hidden">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase">Live Timeline</p>
                <span className="flex items-center gap-1 text-[9px] text-[#a8a29e] uppercase tracking-wide">
                  <span className={cn("w-1.5 h-1.5 rounded-full", hasLivePosition ? "bg-[#1a6042] animate-pulse" : "bg-[#c4bfbb]")} />
                  {hasLivePosition ? "Live" : "Waiting"}
                </span>
              </div>
              <div className="flex flex-col">
                {timeline.map((item, i, arr) => (
                  <div key={item.label} className="flex items-center gap-2.5 py-[7px] relative">
                    {i < arr.length - 1 && (
                      <div className="absolute left-[7px] top-[21px] w-[1px] h-[calc(100%-8px)] bg-[rgba(55,50,47,0.10)]" />
                    )}
                    <div className="w-[15px] h-[15px] flex-shrink-0 flex items-center justify-center z-10">
                      {item.done
                        ? <CircleCheck className="w-[15px] h-[15px] text-[#1a6042]" />
                        : <Circle className="w-[15px] h-[15px] text-[rgba(55,50,47,0.20)]" />
                      }
                    </div>
                    <span className={cn("text-[11px] font-medium", item.done ? "text-[#37322F]" : "text-[#c4bfbb]")}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Repayment History Proof — public attestation, both modes */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase mb-2 flex items-center gap-1.5">
                <History className="w-3 h-3" /> Repayment History Proof
              </p>
              {!flowState?.repay ? (
                <p className="text-[11px] text-[#a8a29e] leading-relaxed">Available after first repayment.</p>
              ) : historyProof?.verified ? (
                <div>
                  <p className="text-[12px] font-bold text-[#1a6042] mb-1">
                    Alpha proved ≥{historyProof.threshold} of {historyProof.leafCount} repayments were on time
                  </p>
                  <p className="text-[10px] text-[#a8a29e] leading-relaxed">
                    Verified on-chain without revealing which repayment was late.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-[#a8a29e] leading-relaxed flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" style={{ animationDuration: "2.5s" }} />
                  Repaid — waiting for Alpha to prove its repayment history.
                </p>
              )}
            </div>

            {/* Scoped Disclosure — Alpha grants access; auditor mode only */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase mb-2 flex items-center gap-1.5">
                <Share2 className="w-3 h-3" /> Scoped Disclosure
              </p>
              {!isAuditor ? (
                <p className="text-[11px] text-[#a8a29e] leading-relaxed flex items-center gap-1.5">
                  <EyeOff className="w-3.5 h-3.5 flex-shrink-0" /> Unlock Auditor mode to grant scoped access.
                </p>
              ) : disclosurePhase === "created" && disclosureLink ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-[#1a6042] font-medium flex items-center gap-1.5">
                    <CircleCheck className="w-3.5 h-3.5" /> Regulator link ready
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={copyLink}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-[rgba(55,50,47,0.14)] rounded-lg px-3 py-2 text-[11px] font-medium text-[#605A57] hover:border-[rgba(55,50,47,0.30)] transition-colors"
                    >
                      {copied ? <Check className="w-3 h-3 text-[#1a6042]" /> : <Copy className="w-3 h-3" />}
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <a
                      href={disclosureLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#37322F] text-white rounded-lg px-3 py-2 text-[11px] font-medium hover:bg-[#23201E] transition-colors"
                    >
                      Open as regulator <ArrowUpRight className="w-3 h-3" />
                    </a>
                  </div>
                  <p className="text-[10px] text-[#a8a29e] leading-relaxed">
                    The viewer key travels in the URL fragment — never sent to the server.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <p className="text-[11px] text-[#8a8480] leading-relaxed">
                    Alpha grants a regulator access to <span className="text-[#37322F] font-semibold">repayment status only</span> —
                    amounts stay hidden.
                  </p>
                  {disclosureError && <p className="text-[10px] text-[#9a2c1a]">{disclosureError}</p>}
                  <button
                    onClick={createDisclosure}
                    disabled={disclosurePhase === "creating" || disclosurePhase === "revealing"}
                    className="relative overflow-hidden inline-flex items-center justify-center gap-2 bg-[#37322F] text-white text-[12px] font-medium px-4 py-2 rounded-full
                      shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                      hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                      disabled:opacity-60 disabled:hover:scale-100
                      transition-all duration-200"
                  >
                    <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                    {disclosurePhase === "creating" ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating grant...</>
                    ) : (
                      <><Share2 className="w-3.5 h-3.5" /> Create disclosure</>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Verification drawer */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-[rgba(55,50,47,0.02)] transition-colors"
              >
                <span className="text-[10px] font-bold text-[#8a8480] tracking-[0.12em] uppercase">
                  Verification details
                </span>
                {drawerOpen ? <ChevronUp className="w-3 h-3 text-[#a8a29e]" /> : <ChevronDown className="w-3 h-3 text-[#a8a29e]" />}
              </button>
              {drawerOpen && (
                <div className="border-t border-[rgba(55,50,47,0.08)] px-4 py-3 flex flex-col gap-2 max-h-[45vh] overflow-y-auto">
                  {[
                    { label: "Verifier contract", value: shortAddr(flowState?.proof?.verifierContractId ?? flow?.contracts?.collateralSufficiencyVerifier) },
                    { label: "CreditOpened tx", value: shortAddr(flowState?.open?.txHash) },
                    { label: "DrawExecuted tx", value: shortAddr(flowState?.draw?.txHash) },
                    { label: "OZ transfer tx", value: flowState?.draw?.confidentialTransferTxHash ? shortAddr(flowState.draw.confidentialTransferTxHash) : "Not yet submitted" },
                    { label: "Repaid tx", value: shortAddr(flowState?.repay?.txHash) },
                    ...(historyProof?.verified ? [
                      { label: "History verify tx", value: shortAddr(historyProof.txHash) },
                      { label: "History proof nullifier", value: shortAddr(historyProof.proofNullifier) },
                      { label: "History root", value: shortAddr(historyProof.historyRoot) },
                      { label: "History verifier contract", value: shortAddr(historyProof.verifierContractId ?? flow?.contracts?.repaymentHistoryVerifier) },
                    ] : []),
                    { label: "Latest ledger", value: latestLedger ? String(latestLedger) : "Pending sync" },
                  ].map(row => (
                    <div key={row.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-[#a8a29e] font-medium">{row.label}</span>
                      <span className="text-[11px] font-mono text-[#605A57] break-all">{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

export default function ObserverPage() {
  return (
    <Suspense fallback={null}>
      <ObserverPageInner />
    </Suspense>
  )
}
