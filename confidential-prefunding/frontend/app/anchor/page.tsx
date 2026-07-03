"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  Building2,
  ArrowUpRight,
  Wifi,
  WifiOff,
  Globe2,
  ShieldCheck,
  Lock,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Transaction {
  id: string
  transaction_id: string
  status: string
  product_status: string
  amount_in: string | null
  amount_out: string | null
  asset_code: string | null
  corridor?: string | null
  settlement_window_days?: number | null
  sender_id: string
  receiver_id?: string | null
  stellar_transaction_id?: string | null
  fields?: Record<string, unknown>
  updated_at: string
}

interface DemoState {
  source: "live" | "cache" | "unavailable"
  error?: string
  snapshot?: {
    network?: { networkPassphrase?: string }
    accounts?: { alpha?: string | null; facility?: string | null; auditor?: string | null }
    anchorPlatform?: { reachable?: boolean }
    product?: {
      latestSepStatus?: string | null
      latestProductStatus?: string | null
      latestSep31Transaction?: {
        id: string
        status: string
        productStatus: string
        amountIn: string | null
        amountOut: string | null
        assetCode: string | null
        senderId: string
        stellarTransactionId: string | null
        startedAt: string
        updatedAt: string
      } | null
    }
  } | null
}

interface Customer {
  id?: string
  account?: string
  status: "ACCEPTED" | "REJECTED" | "PROCESSING" | "NEEDS_INFO"
  updated_at?: string
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

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

// ─── Id Badge (display treatment for reference/transaction ids) ─────────────

function IdBadge({ tag, value }: { tag: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 bg-white rounded-full border border-[rgba(55,50,47,0.12)] pl-1.5 pr-3 py-1 shadow-[0_1px_2px_rgba(55,50,47,0.05)]">
      <span className="text-[9px] font-bold tracking-[0.06em] uppercase bg-[#37322F] text-white rounded-full px-2 py-[3px] leading-none">
        {tag}
      </span>
      <span className="text-[13px] font-bold text-[#37322F] leading-none">
        {value}
      </span>
    </div>
  )
}

// ─── Icon Metric Row (richer variant with per-row icon + optional emphasis) ──

function IconMetricRow({
  icon, label, value, badge, emphasis, tone = "neutral",
}: {
  icon: React.ReactNode
  label: string
  value?: string
  badge?: React.ReactNode
  emphasis?: boolean
  tone?: "neutral" | "success"
}) {
  return (
    <div className="flex items-center justify-between py-[10px] -mx-1.5 px-1.5 rounded-lg border-b border-[rgba(55,50,47,0.07)] last:border-0 hover:bg-[rgba(55,50,47,0.025)] transition-colors">
      <div className="flex items-center gap-2.5">
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden",
          tone === "success" ? "bg-[#1a6042]/10 text-[#1a6042]" : "bg-[rgba(55,50,47,0.05)] text-[#8a8480]"
        )}>
          {icon}
        </div>
        <span className="text-[12px] text-[#8a8480] font-medium">{label}</span>
      </div>
      {badge ?? (
        <span className={cn(
          emphasis ? "text-[16px] text-[#37322F] font-semibold" : "text-[12px] text-[#37322F] font-medium"
        )}>
          {value}
        </span>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-[#8a8480] tracking-[0.14em] uppercase pt-3 pb-1 first:pt-1">
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

function formatAmount(value: string | null | undefined) {
  if (!value) return "50,000"
  const numeric = Number(value.replace(/,/g, ""))
  if (!Number.isFinite(numeric)) return value
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric)
}

function shortNetworkName(passphrase: string | undefined) {
  if (!passphrase) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("test")) return "Stellar Testnet"
  if (passphrase.toLowerCase().includes("public")) return "Stellar Public"
  return "Stellar"
}

function statusDone(productStatus: string, step: "collateral" | "proof" | "draw" | "repay") {
  const order = ["prefunding_required", "credit_quote_ready", "proof_pending", "proof_verified", "credit_drawn", "repaid", "closed"]
  const current = order.indexOf(productStatus)
  const required = {
    collateral: order.indexOf("credit_quote_ready"),
    proof: order.indexOf("proof_verified"),
    draw: order.indexOf("credit_drawn"),
    repay: order.indexOf("repaid"),
  }[step]
  return current >= required
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AnchorPage() {
  const [tx, setTx] = useState<Transaction | null>(null)
  const [demo, setDemo] = useState<DemoState | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [selectedTxId, setSelectedTxId] = useState("sep31-alpha-001")
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  const configuredTxId = process.env.NEXT_PUBLIC_DEMO_SEP31_TRANSACTION_ID

  const load = useCallback(async () => {
    try {
      const demoRes = await fetch(`${API}/api/demo/state`)
      const demoJson = demoRes.ok ? (await demoRes.json()) as DemoState : null
      if (demoJson) setDemo(demoJson)

      const latestTxId = demoJson?.snapshot?.product?.latestSep31Transaction?.id
      const queryTxId = new URLSearchParams(window.location.search).get("tx")
      const txId = queryTxId ?? configuredTxId ?? latestTxId ?? "sep31-alpha-001"
      setSelectedTxId(txId)

      let txRes = await fetch(`${API}/api/sep31/transaction?id=${encodeURIComponent(txId)}`)
      if (txRes.status === 404) {
        const bootstrapRes = await fetch(`${API}/api/demo-flow/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anchorTransactionId: txId,
            account: demoJson?.snapshot?.accounts?.alpha,
            kybStatus: "ACCEPTED",
          }),
        })
        if (!bootstrapRes.ok) {
          throw new Error(`SEP-31 transaction "${txId}" not seeded and bootstrap failed`)
        }
        txRes = await fetch(`${API}/api/sep31/transaction?id=${encodeURIComponent(txId)}`)
      }
      const txJson = txRes.ok ? (await txRes.json()) as Transaction : null
      if (txJson) setTx(txJson)

      const alpha = txJson?.sender_id ?? demoJson?.snapshot?.accounts?.alpha
      if (alpha) {
        const customerRes = await fetch(`${API}/api/sep12/customer?account=${encodeURIComponent(alpha)}&type=sep31-sender`)
        if (customerRes.ok) setCustomer(await customerRes.json())
      }

      if (!demoRes.ok || !txRes.ok) {
        setError("Some backend data unavailable — showing latest cached/demo context")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backend unreachable — demo values shown")
    } finally {
      setLoading(false)
    }
  }, [API, configuredTxId])

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

  const latestTx = demo?.snapshot?.product?.latestSep31Transaction
  const sepStatus = tx?.status ?? latestTx?.status ?? demo?.snapshot?.product?.latestSepStatus ?? "pending_sender"
  const productStatus = tx?.product_status ?? latestTx?.productStatus ?? demo?.snapshot?.product?.latestProductStatus ?? "prefunding_required"
  const amount = formatAmount(tx?.amount_in ?? latestTx?.amountIn)
  const assetCode = tx?.asset_code ?? latestTx?.assetCode ?? "cUSDC"
  const corridor = tx?.corridor ?? String(tx?.fields?.corridor ?? "USD → PHP")
  const settlementDays = tx?.settlement_window_days ?? Number(tx?.fields?.settlement_window_days ?? 3)
  const alphaAccount = tx?.sender_id ?? latestTx?.senderId ?? demo?.snapshot?.accounts?.alpha ?? "GXXXXXXXXXXXXXXXXXX"
  const transactionId = tx?.transaction_id ?? tx?.id ?? latestTx?.id ?? selectedTxId
  const customerStatus = customer?.status ?? "NEEDS_INFO"
  const kybApproved = customerStatus === "ACCEPTED"
  const isLive = demo?.source === "live"
  const networkName = shortNetworkName(demo?.snapshot?.network?.networkPassphrase)
  const paymentTx = tx?.stellar_transaction_id ?? latestTx?.stellarTransactionId
  const workflow = [
    { step: "Payout need", done: true },
    { step: "Review collateral", done: statusDone(productStatus, "collateral") },
    { step: "Request & prove credit", done: statusDone(productStatus, "proof") },
    { step: "Draw cUSDC", done: statusDone(productStatus, "draw") },
    { step: "Repay", done: statusDone(productStatus, "repay") },
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
              Anchor Operator
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
              disabled={loading}
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
              <StatusBadge label={sepStatus.replace(/_/g, " ")} variant="warning" />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[#8a8480]">
              <span>Nyx</span>
              <StatusBadge label={productStatus.replace(/_/g, " ")} variant="pending" />
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
                <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-1">
                  Anchor Operator
                </p>
                <h1 className="text-[26px] font-serif text-[#37322F] leading-tight">
                  Alpha Remit
                </h1>
                <p className="text-[12px] text-[#8a8480] mt-0.5">Institutional payout operator</p>
              </div>
              <StatusBadge
                label={`KYB ${customerStatus.replace(/_/g, " ")}`}
                variant={kybApproved ? "success" : customerStatus === "REJECTED" ? "warning" : "pending"}
              />
            </div>

            {/* Transaction card — grows to fill */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl flex flex-col overflow-hidden shadow-[0_2px_16px_rgba(55,50,47,0.06)]">

              {/* Card header */}
              <div className="flex-shrink-0 px-5 py-3.5 border-b border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[rgba(55,50,47,0.06)] flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-3.5 h-3.5 text-[#605A57]" />
                  </div>
                  <IdBadge tag="SEP-31" value={transactionId} />
                </div>
                <StatusBadge label={sepStatus.replace(/_/g, " ")} variant="warning" />
              </div>

              {/* Metrics */}
              <div className="flex-1 px-5 py-1 overflow-hidden">
                {loading ? (
                  <div className="flex flex-col gap-0">
                    {[1,2,3,4,5,6,7].map(i => (
                      <div key={i} className="flex justify-between py-[9px] border-b border-[rgba(55,50,47,0.07)]">
                        <div className="h-3 w-24 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-[rgba(55,50,47,0.07)] rounded-full animate-pulse" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>
                    <SectionLabel>Payout</SectionLabel>
                    <IconMetricRow
                      icon={<Globe2 className="w-3 h-3" />}
                      label="Payout corridor"
                      value={corridor}
                    />
                    <IconMetricRow
                      icon={<UsdcIcon size={22} />}
                      label="Payout amount"
                      value={`${amount} ${assetCode}`}
                      emphasis
                    />
                    <IconMetricRow
                      icon={<Clock className="w-3 h-3" />}
                      label="Settlement window"
                      value={`${settlementDays} days`}
                    />

                    <SectionLabel>Compliance</SectionLabel>
                    <IconMetricRow
                      icon={<Building2 className="w-3 h-3" />}
                      label="Anchor / SEP-31 status"
                      badge={<StatusBadge label={sepStatus.replace(/_/g, " ")} variant="warning" />}
                    />
                    <IconMetricRow
                      icon={<Lock className="w-3 h-3" />}
                      label="Nyx credit status"
                      badge={<StatusBadge label={productStatus.replace(/_/g, " ")} variant="pending" />}
                    />
                    <IconMetricRow
                      icon={<ShieldCheck className="w-3 h-3" />}
                      label="KYB"
                      tone={kybApproved ? "success" : "neutral"}
                      badge={
                        <StatusBadge
                          label={customerStatus.replace(/_/g, " ")}
                          variant={kybApproved ? "success" : customerStatus === "REJECTED" ? "warning" : "pending"}
                        />
                      }
                    />
                    <IconMetricRow
                      icon={<CheckCircle2 className="w-3 h-3" />}
                      label="Custody profile"
                      tone="success"
                      value="Institutional custody loaded"
                    />
                  </div>
                )}
              </div>

              {/* Card footer — CTA */}
              <div className="flex-shrink-0 px-5 py-4 border-t border-[rgba(55,50,47,0.08)] flex items-center justify-between">
                <p className="text-[11px] text-[#a8a29e] max-w-[340px] leading-relaxed">
                  Credit request driven by a real payout need — not a generic loan UI.
                </p>
                <Link
                  href="/vault"
                  className="relative overflow-hidden inline-flex items-center gap-2 bg-[#37322F] text-white text-[13px] font-medium px-5 py-2.5 rounded-full flex-shrink-0
                    shadow-[0px_0px_0px_2px_rgba(255,255,255,0.08)_inset]
                    hover:bg-[#23201E] hover:scale-[1.02] active:scale-[0.97]
                    transition-all duration-200"
                >
                  <span className="absolute inset-0 bg-gradient-to-b from-white/0 to-black/10 mix-blend-multiply pointer-events-none" />
                  Review collateral
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="h-full flex flex-col gap-4">

            {/* Liquidity need */}
            <div className="flex-shrink-0 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-2.5">
                Liquidity need
              </p>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <span className="text-[24px] font-serif text-[#37322F] leading-none block">
                    {amount}
                  </span>
                  <span className="text-[11px] text-[#8a8480] font-medium">{assetCode} · {settlementDays}-day tenor</span>
                </div>
              </div>
              <div className="w-full h-[1px] bg-[rgba(55,50,47,0.08)] mb-3" />
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#a8a29e]">Corridor</span>
                  <span className="text-[11px] text-[#37322F] font-medium">{corridor}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#a8a29e]">Due</span>
                  <span className="text-[11px] text-[#37322F] font-medium flex items-center gap-1">
                    <Clock className="w-3 h-3 text-[#92400e]" />{settlementDays} days
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-[#a8a29e]">Collateral</span>
                  <span className="text-[11px] text-[#8a8480] italic">Not pledged yet</span>
                </div>
              </div>
            </div>

            {/* Credit workflow stepper — grows */}
            <div className="flex-1 bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-4 shadow-[0_2px_16px_rgba(55,50,47,0.06)]">
              <p className="text-[10px] font-medium text-[#a8a29e] tracking-[0.12em] uppercase mb-3">
                Credit workflow
              </p>
              <div className="flex flex-col">
                {workflow.map((item, i, arr) => (
                  <div key={i} className="flex items-center gap-3 py-2.5 relative">
                    {i < arr.length - 1 && (
                      <div className="absolute left-[8px] top-[26px] w-[1px] h-[calc(100%-10px)] bg-[rgba(55,50,47,0.10)]" />
                    )}
                    <div className={cn(
                      "w-[17px] h-[17px] rounded-full border flex-shrink-0 flex items-center justify-center z-10",
                      item.done ? "bg-[#37322F] border-[#37322F]" : "bg-[#F7F5F3] border-[rgba(55,50,47,0.20)]"
                    )}>
                      {item.done && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                    <span className={cn("text-[12px] font-medium", item.done ? "text-[#37322F]" : "text-[#c4bfbb]")}>
                      {item.step}
                    </span>
                  </div>
                ))}
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
                    { label: "Anchor account",       value: alphaAccount },
                    { label: "SEP-31 transaction ID", value: transactionId },
                    { label: "SEP-12 customer ID",   value: customer?.id ?? "alpha-kyb-001" },
                    { label: "SEP-31 payment tx",     value: paymentTx ?? "Pending draw/payment" },
                  ].map(row => (
                    <div key={row.label} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-[#a8a29e] font-medium">{row.label}</span>
                      <span className="text-[11px] font-mono text-[#605A57] break-all">
                        {row.value.length > 22 ? `${row.value.slice(0, 10)}...${row.value.slice(-8)}` : row.value}
                      </span>
                    </div>
                  ))}
                  <a
                    href={`${API}/api/sep31/transaction?id=${encodeURIComponent(transactionId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 text-[11px] text-[#605A57] hover:text-[#37322F] transition-colors font-medium"
                  >
                    View raw transaction <ArrowUpRight className="w-3 h-3" />
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
