"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  ArrowRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Receipt,
  Lock,
  LockOpen,
  Loader2,
  CheckCircle2,
  Circle,
  RefreshCw,
  Wifi,
  WifiOff,
  ShieldCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Types ───────────────────────────────────────────────────────────────────

interface DemoState {
  source: "live" | "cache" | "unavailable"
  snapshot?: {
    network?: { networkPassphrase?: string }
    contracts?: Record<string, string>
    stellar?: { rpc?: { latestLedgerSequence?: number | null } }
  } | null
}

interface DemoFlowState {
  state: {
    anchorTransactionId: string | null
    positionId: string | null
    draw: {
      txHash: string
      confidentialTransferTxHash: string | null
    } | null
    repay: {
      txHash: string
      ledger?: number | null
      repaymentCommitment: string
      confidentialTransferTxHash: string | null
    } | null
    historyProof: {
      verified: boolean
      threshold: number
      onTimeCount: number
      leafCount: number
      txHash: string
    } | null
  }
  anchorTransaction: {
    sepStatus: string
    productStatus: string
    stellarTransactionId: string | null
  } | null
}

type Phase = "outstanding" | "repaying" | "repaid"

// ─── Shared components (same pattern as prior pages) ─────────────────────────

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

function dueDate(tenorDays: number) {
  const d = new Date()
  d.setDate(d.getDate() + tenorDays)
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d)
}

// ─── Page ────────────────────────────────────────────────────────────────────

function RepayPageInner() {
  const params = useSearchParams()
  const amount = Number(params.get("amount") ?? "50000")
  const fee = Number(params.get("fee") ?? "175")
  const tenor = Number(params.get("tenor") ?? "3")
  const collateral = params.get("collateral") ?? "cTBill"
  const queryPositionId = params.get("positionId")
  const outstanding = String(amount + fee)

  const [demo, setDemo] = useState<DemoState | null>(null)
  const [flow, setFlow] = useState<DemoFlowState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("outstanding")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [historyProofing, setHistoryProofing] = useState(false)
  const [historyProofError, setHistoryProofError] = useState<string | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

  const load = useCallback(async () => {
    try {
      const [demoRes, flowRes] = await Promise.all([
        fetch(`${API}/api/demo/state`),
        fetch(`${API}/api/demo-flow/state`),
      ])
      if (demoRes.ok) setDemo(await demoRes.json())
      if (flowRes.ok) {
        const flowJson = await flowRes.json() as DemoFlowState
        setFlow(flowJson)
        if (flowJson.state.repay) setPhase("repaid")
      }
      if (!demoRes.ok || !flowRes.ok) setError("Backend state unavailable")
    } catch {
      setError("Backend unreachable")
    } finally {
      setLoading(false)
    }
  }, [API])

  useEffect(() => {
    async function initial() {
      await load()
    }
    initial()
  }, [load])

  function refresh() {
    setLoading(true)
    setError(null)
    void load()
  }

  const isLive = demo?.source === "live"
  const networkName = shortNetworkName(demo?.snapshot?.network?.networkPassphrase)
  const creditLineAddr = demo?.snapshot?.contracts?.prefundingCreditLine
  const repaymentHistoryAddr = demo?.snapshot?.contracts?.repaymentHistory
  const latestLedger = demo?.snapshot?.stellar?.rpc?.latestLedgerSequence
  const flowState = flow?.state
  const historyProof = flowState?.historyProof
  const sepStatus = flow?.anchorTransaction?.sepStatus ?? (phase === "repaid" ? "completed" : "pending_stellar")
  const productStatus = flow?.anchorTransaction?.productStatus ?? (phase === "repaid" ? "repaid" : "credit_drawn")

  async function runRepay() {
    setPhase("repaying")
    setError(null)
    try {
      const res = await fetch(`${API}/api/demo-flow/repay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionId: queryPositionId || flowState?.positionId || undefined,
          anchorTransactionId: flowState?.anchorTransactionId ?? undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Repayment failed")
      setFlow(await (await fetch(`${API}/api/demo-flow/state`)).json())
      setPhase("repaid")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase("outstanding")
    }
  }

  async function runHistoryProof() {
    setHistoryProofing(true)
    setHistoryProofError(null)
    try {
      const res = await fetch(`${API}/api/demo-flow/history-proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionId: queryPositionId || flowState?.positionId || undefined,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Repayment history proof failed")
      setFlow(await (await fetch(`${API}/api/demo-flow/state`)).json())
    } catch (e) {
      setHistoryProofError(e instanceof Error ? e.message : String(e))
    } finally {
      setHistoryProofing(false)
    }
  }

  const checklist = [
    { label: "Repayment", done: phase === "repaid" },
    { label: "SEP-31 completed", done: phase === "repaid" },
    { label: "Collateral lock released", done: phase === "repaid" },
    { label: "Repayment history", done: Boolean(historyProof?.verified), updating: false },
  ]

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
              Repayment
            </span>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="text-[10px] text-[#92400e] flex items-center gap-1">
                <WifiOff className="w-3 h-3" />{error}
              </span>
            )}
            <button
              onClick={refresh}
              disabled={loading || phase === "repaying" || historyProofing}
              title="Refresh data"
              className="w-6 h-6 rounded-full flex items-center justify-center text-[#8a8480] hover:text-[#37322F] hover:bg-[rgba(55,50,47,0.06)] disabled:opacity-40 transition-colors"
            >
              <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
            </button>
            <span className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              {isLive ? <Wifi className="w-3 h-3 text-[#1a6042]" /> : <span className="w-1.5 h-1.5 rounded-full bg-[#a8a29e]" />}
              {networkName}
            </span>
            <span className="w-[1px] h-3.5 bg-[rgba(55,50,47,0.15)]" />
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              <span className="font-mono">SEP-31</span>
              <StatusBadge label={sepStatus.replace(/_/g, " ")} variant={phase === "repaid" ? "success" : "warning"} />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              <span>Nyx</span>
              <StatusBadge label={productStatus.replace(/_/g, " ")} variant="pending" />
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
                  href="/draw"
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-[#a8a29e] hover:text-[#605A57] tracking-[0.1em] uppercase mb-1 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" /> Credit Opened &amp; Draw
                </Link>
                <h1 className="text-[26px] font-serif text-[#37322F] leading-tight">
                  Repayment
                </h1>
                <p className="text-[12px] text-[#8a8480] mt-0.5">Alpha Remit · closing {collateral} position</p>
              </div>
              <StatusBadge label={phase === "repaid" ? "Repaid" : "On time"} variant="success" />
            </div>

            {/* Main card — grows to fill */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl flex flex-col overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">

              {/* Card header */}
              <div className="flex-shrink-0 px-5 py-3.5 border-b border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[rgba(55,50,47,0.06)] flex items-center justify-center flex-shrink-0">
                    <Receipt className="w-3.5 h-3.5 text-[#605A57]" />
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.1em] uppercase">
                      Position
                    </p>
                    <p className="text-[12px] font-mono text-[#37322F] font-medium leading-tight">
                      {formatAmount(String(amount))} cUSDC · {tenor}d
                    </p>
                  </div>
                </div>
                <StatusBadge label={phase === "repaid" ? "Closed" : "Active"} variant={phase === "repaid" ? "success" : "warning"} />
              </div>

              {/* Body */}
              <div className="flex-1 px-5 py-1 overflow-hidden">
                {loading ? (
                  <div className="flex flex-col gap-0 pt-2">
                    {[1,2,3,4].map(i => (
                      <div key={i} className="flex justify-between py-[9px] border-b border-[rgba(55,50,47,0.07)]">
                        <div className="h-3 w-24 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                      </div>
                    ))}
                  </div>
                ) : phase !== "repaid" ? (
                  <div>
                    <MetricRow label="Outstanding repayment" value={`${formatAmount(outstanding)} cUSDC`} />
                    <MetricRow label="Due date" value={dueDate(tenor)} />
                    <MetricRow label="Status" badge={<StatusBadge label="On time" variant="success" />} />
                    <MetricRow label="Collateral lock" badge={<StatusBadge label="Active" variant="success" />} />
                  </div>
                ) : (
                  <div>
                    <MetricRow label="Repayment" badge={<StatusBadge label="Confirmed" variant="success" />} />
                    <MetricRow label="SEP Status" badge={<StatusBadge label="completed" variant="success" />} />
                    <MetricRow label="Product Status" badge={<StatusBadge label="repaid" variant="pending" />} />
                    <MetricRow label="Collateral lock" badge={<StatusBadge label="Released" variant="success" />} />
                    <MetricRow
                      label="Repayment history"
                      badge={
                        historyProof?.verified
                          ? <StatusBadge label={`≥${historyProof.threshold}/${historyProof.leafCount} verified`} variant="success" />
                          : <StatusBadge label="Ready for proof" variant="warning" />
                      }
                    />
                  </div>
                )}
              </div>

              {/* Card footer */}
              <div className="flex-shrink-0 px-5 py-4 border-t border-[rgba(55,50,47,0.08)] flex items-center justify-between gap-3">
                <p className="text-[11px] text-[#a8a29e] max-w-[300px] leading-relaxed">
                  {phase === "outstanding" && "Repaying releases the collateral lock and feeds the private repayment history."}
                  {phase === "repaying" && "Submitting repayment and closing the credit position."}
                  {phase === "repaid" && !historyProof?.verified && !historyProofError &&
                    "Position closed. Prove your repayment track record without revealing amounts or dates."}
                  {phase === "repaid" && historyProofError && (
                    <span className="text-[#9a2c1a]">{historyProofError}</span>
                  )}
                  {phase === "repaid" && historyProof?.verified && (
                    <>
                      History proven on-chain — ≥{historyProof.threshold} of {historyProof.leafCount} on time.{" "}
                      <Link href="/anchor" className="underline hover:text-[#605A57] transition-colors">
                        Start a new payout
                      </Link>
                    </>
                  )}
                </p>

                {phase === "outstanding" && (
                  <button
                    onClick={runRepay}
                    className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                      shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                      hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                      transition-all duration-200"
                  >
                    <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                    Repay credit line
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}

                {phase === "repaying" && (
                  <button
                    disabled
                    className="inline-flex items-center gap-2 bg-[#37322F]/60 text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0 cursor-not-allowed"
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Confirming...
                  </button>
                )}

                {phase === "repaid" && !historyProof?.verified && (
                  <button
                    onClick={runHistoryProof}
                    disabled={historyProofing}
                    className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                      shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                      hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                      disabled:opacity-60 disabled:hover:scale-100
                      transition-all duration-200"
                  >
                    <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                    {historyProofing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    {historyProofing ? "Proving history..." : "Prove repayment history"}
                  </button>
                )}

                {phase === "repaid" && historyProof?.verified && (
                  <span className="inline-flex items-center gap-2 text-[#1a6042] text-[13px] font-medium px-2 flex-shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                    Closed
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Repayment amount hero */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-2.5">
                {phase === "repaid" ? "Repayment amount" : "Outstanding repayment"}
              </p>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <span className="text-[24px] font-serif text-[#37322F] leading-none block">
                    {formatAmount(outstanding)}
                  </span>
                  <span className="text-[11px] text-[#8a8480] font-medium">cUSDC · due {dueDate(tenor)}</span>
                </div>
              </div>
              <div className="w-full h-[1px] bg-[rgba(55,50,47,0.08)] mb-3" />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#a8a29e]">Collateral</span>
                <span className="text-[11px] text-[#37322F] font-medium flex items-center gap-1">
                  {phase === "repaid" ? (
                    <><LockOpen className="w-3 h-3 text-[#1a6042]" /> Released</>
                  ) : (
                    <><Lock className="w-3 h-3 text-[#92400e]" /> Locked</>
                  )}
                </span>
              </div>
            </div>

            {/* Closing checklist — grows */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-3">
                Closing checklist
              </p>
              <div className="flex flex-col">
                {checklist.map((item, i, arr) => (
                  <div key={item.label} className="flex items-center gap-3 py-2.5 relative">
                    {i < arr.length - 1 && (
                      <div className="absolute left-[8px] top-[26px] w-[1px] h-[calc(100%-10px)] bg-[rgba(55,50,47,0.10)]" />
                    )}
                    <div className="w-[17px] h-[17px] flex-shrink-0 flex items-center justify-center z-10">
                      {item.updating ? (
                        <RefreshCw className="w-[15px] h-[15px] text-[#92400e] animate-spin" style={{ animationDuration: "2s" }} />
                      ) : item.done ? (
                        <CheckCircle2 className="w-[17px] h-[17px] text-[#1a6042]" />
                      ) : (
                        <Circle className="w-[17px] h-[17px] text-[rgba(55,50,47,0.20)]" />
                      )}
                    </div>
                    <span className={cn(
                      "text-[12px] font-medium",
                      item.done || item.updating ? "text-[#37322F]" : "text-[#c4bfbb]"
                    )}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Verification drawer */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                disabled={phase !== "repaid"}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-[rgba(55,50,47,0.02)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <span className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase">
                  Verification details
                </span>
                {drawerOpen && phase === "repaid"
                  ? <ChevronUp className="w-3 h-3 text-[#a8a29e]" />
                  : <ChevronDown className="w-3 h-3 text-[#a8a29e]" />
                }
              </button>
              {drawerOpen && phase === "repaid" && (
                <div className="border-t border-[rgba(55,50,47,0.08)] px-4 py-3 flex flex-col gap-2.5 max-h-[45vh] overflow-y-auto">
                  {[
                    { label: "Repaid tx hash",              value: shortAddr(flowState?.repay?.txHash) },
                    { label: "Repayment commitment",        value: shortAddr(flowState?.repay?.repaymentCommitment) },
                    { label: "Repayment cUSDC tx",           value: shortAddr(flowState?.repay?.confidentialTransferTxHash) },
                    { label: "Closed ledger",                value: flowState?.repay?.ledger ? String(flowState.repay.ledger) : latestLedger ? String(latestLedger) : "Pending sync" },
                    { label: "Collateral lock release",     value: "Released" },
                    { label: "Position ID",                  value: shortAddr(flowState?.positionId) },
                  ].map(row => (
                    <div key={row.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-[#a8a29e] font-medium">{row.label}</span>
                      <span className="text-[11px] font-mono text-[#605A57] break-all">{row.value}</span>
                    </div>
                  ))}
                  {flowState?.repay?.txHash && (
                    <a
                      href={`https://stellar.expert/explorer/${(demo?.snapshot?.network?.networkPassphrase ?? "").toLowerCase().includes("public") ? "public" : "testnet"}/tx/${flowState.repay.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-[#1a6042] hover:text-[#14503a] transition-colors"
                    >
                      View repayment transaction on Stellar Expert <ArrowUpRight className="w-3 h-3" />
                    </a>
                  )}
                  <a
                    href={`${API}/api/demo/state`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] text-[#605A57] hover:text-[#37322F] transition-colors font-medium"
                  >
                    Credit line {shortAddr(creditLineAddr)} · History {shortAddr(repaymentHistoryAddr)} <ArrowUpRight className="w-3 h-3" />
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

export default function RepayPage() {
  return (
    <Suspense fallback={null}>
      <RepayPageInner />
    </Suspense>
  )
}
