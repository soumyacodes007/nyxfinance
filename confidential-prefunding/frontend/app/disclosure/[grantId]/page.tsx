"use client"

import { use, useEffect, useState } from "react"
import Link from "next/link"
import { ShieldCheck, EyeOff, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

// ─── Crypto helpers — mirrors backend disclosure AES-GCM envelope logic ─────

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

interface EncryptedBundle {
  ciphertext: string
  nonce: string
  authTag: string
  algorithm: string
}

async function decryptBundle(encrypted: EncryptedBundle, viewerSecret: string): Promise<Record<string, unknown>> {
  const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerSecret)))
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"])
  const ciphertext = base64UrlBytes(encrypted.ciphertext)
  const tag = base64UrlBytes(encrypted.authTag)
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlBytes(encrypted.nonce).slice().buffer, tagLength: 128 },
    key,
    combined
  )
  return JSON.parse(new TextDecoder().decode(plaintext))
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GrantResponse {
  grant: {
    grantId: string
    viewerHash: string
    scopeHash: string
    bundleHash: string
    expiresAtLedger: number
    onChainTxHash: string | null
    revoked: boolean
  }
  encryptedBundle: EncryptedBundle
  grantStatus: { revoked: boolean; expired: boolean; latestLedger: number | null }
}

type Status = "checking" | "verified" | "failed"

const FIELD_LABELS: Record<string, string> = {
  repaymentStatus: "Repayment status",
  threshold: "Threshold",
  onTimeRepayments: "On-time repayments",
  totalRepayments: "Total private repayments",
  positionStatus: "Position status",
}

function formatScopedValue(key: string, value: unknown): string {
  if (key === "repaymentStatus" && value === "on_time_threshold_met") {
    return "Threshold met"
  }
  return String(value)
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DisclosurePage({ params }: { params: Promise<{ grantId: string }> }) {
  const { grantId } = use(params)

  const [status, setStatus] = useState<Status>("checking")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [scopedData, setScopedData] = useState<Record<string, unknown> | null>(null)
  const [scopeLabel, setScopeLabel] = useState<string | null>(null)
  const [grantStatus, setGrantStatus] = useState<GrantResponse["grantStatus"] | null>(null)
  const [expiresAtLedger, setExpiresAtLedger] = useState<number | null>(null)
  const [onChainTxHash, setOnChainTxHash] = useState<string | null>(null)

  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

  useEffect(() => {
    async function verify() {
      try {
        const fragment = new URLSearchParams(window.location.hash.slice(1))
        const viewerSecret = fragment.get("key")
        if (!viewerSecret) throw new Error("Missing viewer key in link")

        const res = await fetch(`${API}/api/disclosure/${encodeURIComponent(grantId)}`)
        const payload = (await res.json()) as GrantResponse | { error: string }
        if (!res.ok) throw new Error("error" in payload ? payload.error : "Disclosure lookup failed")
        const body = payload as GrantResponse

        setGrantStatus(body.grantStatus)
        setExpiresAtLedger(body.grant.expiresAtLedger)
        setOnChainTxHash(body.grant.onChainTxHash ?? null)
        if (body.grantStatus.revoked) throw new Error("This disclosure grant has been revoked")
        if (body.grantStatus.expired) throw new Error("This disclosure grant has expired")

        const expectedViewerHash = await sha256Hex(viewerSecret)
        if (expectedViewerHash !== body.grant.viewerHash) throw new Error("Viewer key does not match this grant")

        const computedBundleHash = await sha256Hex(
          `${body.encryptedBundle.algorithm}:${body.encryptedBundle.nonce}:${body.encryptedBundle.authTag}:${body.encryptedBundle.ciphertext}`
        )
        if (computedBundleHash !== body.grant.bundleHash) throw new Error("Encrypted bundle hash mismatch")

        const plaintext = await decryptBundle(body.encryptedBundle, viewerSecret)
        const scope = plaintext.scope as { fields: string[]; label?: string } | undefined
        const computedScopeHash = await sha256Hex(stableJson(scope))
        if (computedScopeHash !== body.grant.scopeHash) throw new Error("Scope hash mismatch")

        setScopeLabel(scope?.label ?? "Scoped disclosure")
        setScopedData((plaintext.scopedData as Record<string, unknown>) ?? {})
        setStatus("verified")
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e))
        setStatus("failed")
      }
    }
    verify()
  }, [API, grantId])

  return (
    <div className="min-h-screen w-full bg-[#F7F5F3] flex items-center justify-center px-6 py-12 relative">
      <div className="pointer-events-none fixed inset-y-0 left-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[1px_0_0_white]" />
      <div className="pointer-events-none fixed inset-y-0 right-0 w-[1px] bg-[rgba(55,50,47,0.10)] shadow-[-1px_0_0_white]" />

      <div className="w-full max-w-[440px]">
        <div className="text-center mb-6">
          <Link href="/" className="text-[13px] font-medium text-[#37322F] hover:opacity-70 transition-opacity">
            Nyx
          </Link>
          <p className="text-[10px] font-bold text-[#a8a29e] tracking-[0.14em] uppercase mt-3">
            Scoped Disclosure
          </p>
        </div>

        <div className="bg-[#FDFAF6] border border-[rgba(55,50,47,0.10)] rounded-2xl p-7 shadow-[0_4px_24px_rgba(55,50,47,0.08)]">
          {status === "checking" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 text-[#8a8480] animate-spin" />
              <p className="text-[12px] text-[#8a8480]">Decrypting locally in your browser…</p>
            </div>
          )}

          {status === "failed" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <AlertTriangle className="w-6 h-6 text-[#9a2c1a]" />
              <p className="text-[13px] font-bold text-[#9a2c1a]">Could not verify disclosure</p>
              <p className="text-[12px] text-[#8a8480] leading-relaxed">{errorMessage}</p>
            </div>
          )}

          {status === "verified" && scopedData && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-2 justify-center">
                <CheckCircle2 className="w-4 h-4 text-[#1a6042]" />
                <span className="text-[11px] font-bold text-[#1a6042] tracking-[0.08em] uppercase">
                  Verified locally · no plaintext sent by server
                </span>
              </div>

              <div className="text-center">
                <p className="text-[10px] font-bold text-[#a8a29e] tracking-[0.12em] uppercase mb-2">
                  {scopeLabel}
                </p>
                <div className="inline-flex items-center gap-2.5 bg-white border border-[#1a6042]/25 rounded-full px-5 py-3 shadow-[0_4px_16px_rgba(26,96,66,0.10)]">
                  <ShieldCheck className="w-4 h-4 text-[#1a6042]" />
                  <span className="text-[16px] font-bold text-[#1a6042]">
                    {scopedData.repaymentStatus === "on_time_threshold_met"
                      ? "Repayment threshold met"
                      : scopedData.repaymentStatus === "on_time"
                        ? "On-time"
                        : String(scopedData.repaymentStatus ?? "—")}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-0 border-t border-[rgba(55,50,47,0.08)] pt-3">
                {Object.entries(scopedData).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-[rgba(55,50,47,0.06)] last:border-0">
                    <span className="text-[12px] text-[#8a8480] font-medium">{FIELD_LABELS[key] ?? key}</span>
                    <span className="text-[12px] text-[#37322F] font-bold">{formatScopedValue(key, value)}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-1.5 pt-1">
                {["Collateral amount", "Draw amount", "Fee", "Full audit trail"].map((label) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-[11px] text-[#a8a29e]">{label}</span>
                    <span className="flex items-center gap-1 text-[11px] text-[#a8a29e] italic">
                      <EyeOff className="w-3 h-3" /> Not shared
                    </span>
                  </div>
                ))}
              </div>

              {onChainTxHash && (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${onChainTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 text-[11px] font-bold text-[#1a6042] hover:text-[#14503a] transition-colors"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Grant anchored on-chain · view transaction
                </a>
              )}

              {grantStatus && (
                <p className="text-[10px] text-[#c4bfbb] text-center pt-1">
                  Grant expires at ledger {String(expiresAtLedger ?? "—")} · revocable by Alpha at any time
                </p>
              )}
            </div>
          )}
        </div>

        <p className={cn("text-[11px] text-[#a8a29e] text-center mt-4 leading-relaxed")}>
          This page decrypted the disclosure bundle using the key in the link — the backend
          never had access to the plaintext value shown above.
        </p>
      </div>
    </div>
  )
}
