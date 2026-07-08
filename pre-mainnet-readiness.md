# Nyx — Pre-Mainnet Readiness & Sellability

Companion to `audit-findings.md`. Two questions, answered separately:

- **Part A — Before mainnet:** which findings *must* be closed before real value touches the chain.
- **Part B — To make it sellable:** the product-design work that makes an anchor (and a lender) actually buy.

Status legend: ✅ done & verified · 🟡 partially done · ❌ open.

---

# Part A — Before mainnet

## A.0 Current state of the audit fixes

| Finding | What it is | Status |
|:--|:--|:--|
| K1 | Lock registry access control | ✅ applied + build-verified |
| K3 | `anchor.require_auth()` in `open_credit` | ✅ applied |
| K4 | Oracle future-timestamp guard | ✅ applied |
| K5 | TTL on replay/lock state | ✅ applied |
| K6 | Checks-effects-interactions ordering | ✅ applied |
| K7 | Repayment error code | ✅ applied |
| O1/O2 | 7 cross-calls → 2 | ✅ applied |
| **F1/C1** | **Collateral proof bound to real balance + ownership** | 🟡 circuit + contract done & soundness-tested; **VK regen + verifier redeploy + backend prover still required** |
| **F2** | **Real escrow / freeze / liquidation** | 🟡 freeze-on-open + unfreeze-on-repay + `liquidate()` default path + `CollateralSeized` implemented & build-verified; needs operator to hold manager role on the confidential token, and segregated per-amount escrow-transfer as a later refinement |
| **K2** | **Draw amount bound to proven credit** | ✅ `execute_draw` now rejects any commitment != the proven `credit_commitment` |
| C3 | Repayment-history proof binding | ❌ open |
| C2 | Explicit range bounds | 🟡 folded into the C1 circuit |

## A.1 Hard gates — do NOT put real money on mainnet without these

1. **Finish F1/C1 end-to-end.** The circuit + contract are done and soundness-tested, but the fix isn't *live* until you:
   - regenerate the VK (`nargo compile` + `bb write_vk`; needs `jq` in CI — public inputs changed 9 → 11),
   - **redeploy `CollateralSufficiencyVerifier`** with the new VK,
   - update the off-chain prover to supply the new witness (`sk`, balance opening) and drop the two removed `open_credit` args.
   Until this ships, the deployed system still accepts fabricated collateral.

2. **F2 — real collateral enforcement.** For a credit product, collateral must be *encumbered*: escrow/freeze on open, release on repay, seize on default. Without it there is nothing backing the loan and no lender is protected. This is the single biggest remaining gate.

3. **K2 — bind the draw to the proven amount.** Today `execute_draw` takes an arbitrary commitment unrelated to the proof. The released cUSDC must equal what was proven sufficient.

4. **Deploy the FIXED WASM, and add upgradeability + a pause switch first.** Your contracts are currently immutable with no kill-switch. On mainnet a bug is permanent and unstoppable. Add: `upgrade` behind a timelocked multisig, a global `pause` checked in `open_credit`/`execute_draw`, and role separation (admin / manager / operator / pauser / liquidator).

5. **Real oracle.** K4 fixed the future-timestamp bypass, but mainnet needs a real **signed Reflector feed** with staleness + deviation bounds and a breaker — not manual `set_price` as source of truth. Point at mainnet Reflector contract IDs.

6. **Key management.** Multisig admin; operator/executor keys in HSM/MPC, never in `.env`. (`.env` is already gitignored — verified — keep it that way.)

## A.2 Strongly recommended before mainnet

7. **Test coverage + CI.** `collateral_sufficiency` now has soundness tests (accept / reject-wrong-owner / reject-insufficient). Still missing: tests for `repayment_history`, contract-level integration tests for the full open→draw→repay→liquidate flow, and a CI pipeline pinning `nargo`/`bb`/`cargo` versions.

8. **C3 — repayment-history binding.** Same class as C1: bind the proof to on-chain seeded leaves so the root isn't operator-self-attested.

9. **Accounting invariants.** Enforce/monitor: no draw without live escrow; Σ(outstanding draws) ≤ facility liquidity; every open position has an escrow entry.

10. **Third-party audit** — one Soroban contract audit + one ZK-circuit audit. For a grant with real value, this is expected, and the circuits are the trust root so they need their own review.

## A.3 Mainnet cost note

The security fixes are ~cost-neutral (O1/O2 made `open_credit` cheaper; K5 adds minor rent). New contracts (escrow, governance) add small one-time deploy + a few XLM of recoverable reserves. ZK soundness does **not** raise on-chain verification cost (constant for UltraHonk). The real budget line is **facility liquidity + account reserves**, not fees. See `audit-findings.md` for the constraint-count analysis.

---

# Part B — To make it sellable

The contracts are not the blocker to a sale. These are.

## B.1 The structural problem

Nyx is a **two-sided credit marketplace, but only the borrower side is designed.** The flow assumes a "Facility" appears with cUSDC. A product only exists if someone funds it. Every item below is a lender or anchor asking "why would I?"

## B.2 Deal-breakers (with the design fix)

1. **"What happens on default?"** — No recovery playbook. Liquidating *confidential* collateral is operationally hard (who decrypts, prices, auctions). **Fix:** design default→recovery as a first-class flow: grace period → auditor-key disclosure of that one position → seize escrow → settle. Short tenors bound the risk window.

2. **"Why is this lower-risk than normal lending?"** — Your best under-used insight: each loan is tied to a **SEP-31 payout that will settle**, so it's **self-liquidating, payout-linked financing** (like receivables factoring), with collateral only as backstop. **Position the product around this.**

3. **"What collateral do anchors even have?"** — Borrowing USDC against USDC is pointless. The product only works if collateral is a **yield-bearing asset they don't want to sell** — tokenized T-bills / RWA. **The pitch:** keep earning T-bill yield; borrow stablecoin against it for payout spikes.

4. **"What does it cost, and do I save?"** — No unit economics. **Design the number:** for a $50k / 3-day prefund, show fee + rate vs. the yield kept by not selling + capital freed from idle corridors.

5. **"Who runs the executor / holds keys?"** — One operator signs everything. **Decide the operating model:** self-hosted (anchor runs it) vs. Nyx-SaaS vs. consortium. This reshapes custody, liability, and GTM.

6. **"This is a one-shot loan; I need a facility."** — Redesign from single-use positions to a **revolving credit line** with an approved limit and utilization.

7. **"Privacy is nice, but I must underwrite you."** — Full privacy fights underwriting. **Design explicit disclosure tiers:** public sees status; the facility/underwriter sees a defined risk view (leverage bands, LTV) via selective disclosure; auditor sees full on authorization.

8. **"What's the regulatory posture?"** — Decide Nyx's role: tech provider vs. lender-of-record vs. marketplace. Who holds credit risk determines licensing.

## B.3 The supply side: Blend integration

Blend (Soroban lending primitive — pools, reactive rates, backstop) is the likely answer to "who funds the facility," and it gives a market cost of funds (anchor rate = Blend rate + Nyx spread).

**But you cannot put confidential collateral into Blend** — Blend liquidates by reading collateral value; it can't see hidden amounts. So the architecture is **Nyx as an intermediary**, not collateral-in-Blend:

```
Anchor (private) ──cTBill escrow + ZK sufficiency──▶ Nyx (origination + servicing + risk)
                                                        │ borrows wholesale (public, aggregate)
                                                        ▼
                                                   Blend pool (lenders + backstop)
```

- Blend sees only Nyx's **aggregate** book (a normal public borrower) → anchor privacy preserved.
- Nyx is the confidential last mile: proofs, escrow, servicing, recovery.
- Short-dated payout-linked loans mean Nyx's Blend borrowing is self-liquidating too → less backstop capital needed.

**What Blend hands back to you:** Nyx becomes the credit intermediary, so *you* own (a) confidential-collateral liquidation (= F2), (b) first-loss/backstop capital, and (c) a lender-of-record regulatory posture.

**Risk waterfall:** confidential anchor collateral → Nyx backstop (first loss) → Blend pool.

*Caveat: verify against current Blend docs whether they expose isolated pools + a custom risk-oracle/adapter. If so, a tighter integration (Nyx risk-oracle feeds pool health from ZK proofs) is possible; the intermediary model works even if not.*

## B.4 Recommended product shape (first wedge)

> **Payout-linked, self-liquidating prefunding lines for anchors, collateralized by confidential tokenized-RWA, funded via Blend.**

Narrow hard to prove the loop: **one** collateral type (tokenized T-bills), **one** corridor pattern, **one** funding source (Nyx capital or a single Blend pool), a **revolving** line (not one-shot), and a **demoed default playbook** — that last one is what converts a lender.

---

# Part C — Sequenced path

| Phase | Goal | Contents |
|:--|:--|:--|
| **P0 — Finish soundness** | Make the claim true & live | Ship F1/C1 (VK regen + verifier redeploy + prover), then F2 escrow + K2 |
| **P1 — Safety** | Mainnet-survivable | Upgradeability, pause, role separation, real Reflector, multisig keys |
| **P2 — Assurance** | Grant/audit-ready | Circuit + contract tests, CI, C3, accounting invariants, external audit |
| **P3 — Supply side** | Sellable | Blend intermediary integration, backstop model, unit economics |
| **P4 — Product** | Anchor-ready | Revolving line, disclosure tiers, default playbook, operating-model decision |

**Gating truth:** P0 must land before mainnet with real value. P3–P4 are what make it *sellable* — and they mostly define *what* P0/P1 must build, so decide the product shape (Blend intermediary, revolving, default flow) early even though you build it later.
