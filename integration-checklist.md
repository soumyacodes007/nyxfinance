# Nyx — Integration Checklist (contracts & circuits frozen)

Assumption: the circuit (`collateral_sufficiency` v2) and the Soroban contracts are **final**. This is everything *else* needed to make them live, plus the honest answer to "is it sellable after this."

Legend: 🔴 blocker · 🟠 required · 🟢 nice-to-have.

---

## 1. VK + verifier (do first)

- [ ] 🔴 Regenerate the collateral VK in CI (needs `jq`):
      `nargo compile --package circuit_collateral_sufficiency`
      `bb write_vk -s ultra_honk -b target/circuit_collateral_sufficiency.json -o vks/`
      then strip to the 1760-byte on-chain layout (same as `scripts/build_vk_bins.sh`).
- [ ] 🔴 Redeploy `CollateralSufficiencyVerifier` with the new VK. **Public inputs changed 9 → 11**, so the old verifier will reject every new proof.
- [ ] 🟠 Update config/env with the new verifier contract ID.

## 2. Contract redeploy (immutable — fresh deploy)

- [ ] 🔴 Rebuild + redeploy the changed contracts: `prefunding-credit-line`, `collateral-lock-registry`, `oracle-adapter`, `repayment-history-registry`.
- [ ] 🔴 Re-run constructors and update env with new contract IDs.
- [ ] 🟠 `CreditPosition` storage layout changed (new `defaulted` field) — fine on fresh deploy; do **not** point new code at old state.

## 3. Role wiring (NEW — these are the easy-to-miss ones)

- [ ] 🔴 Grant the credit line's **operator/executor** the `manager` role on the **CollateralLockRegistry** — `lock`/`release` are now access-controlled (K1).
- [ ] 🔴 Grant the operator the `manager` role on the **confidential collateral token (cTBill)** — `open_credit`/`repay` now call `freeze`/`unfreeze` (F2).
- [ ] 🟠 Confirm the operator already holds `manager` on the credit line and oracle.
- [ ] 🟠 Backend must sign the **nested auth** for the lock/freeze sub-calls (simulate → sign the full auth tree).

## 4. Backend prover (the witness)

- [ ] 🔴 Feed the circuit the new **private witness**: `sk` (anchor spending secret), the balance opening `(collateral_amount, collateral_randomness)` of the real `spendable_balance`, `(credit_amount, credit_randomness)`, `position_secret`.
- [ ] 🔴 Read `c_spend` + `Y` from the cTBill account (`confidential_balance(anchor)`) and build the **11 public inputs in canonical order**: `c_spend(x,y) | Y(x,y) | credit_commitment(x,y) | price | haircut | tenor | lock_key | position_nullifier`. Must byte-match what `open_credit` rebuilds.
- [ ] 🔴 **Decide who holds `sk` and runs the prover.** The ownership proof needs the anchor's spending secret. Either the anchor proves client-side (keeps `sk`) or delegates to a prover in a TEE. This is a custody + UX decision, not just plumbing — do not ship the anchor's `sk` to a plaintext backend.

## 5. Backend API calls that changed

- [ ] 🔴 `open_credit`: **remove** `collateral_commitment_x/y` args (now sourced on-chain); **add the anchor's signature** (K3 — anchor must auth).
- [ ] 🔴 `execute_draw`: new signature `(position_id, facility, transfer_commitment_x, transfer_commitment_y, operator)`. Pass the position's `credit_commitment` coords, and make the actual cUSDC transfer commit to that **same (amount, randomness)** — otherwise the draw reverts (K2).
- [ ] 🟠 `repay`: same args, but now triggers `unfreeze` (needs the role from §3).
- [ ] 🟠 Wire the new **`liquidate(position_id, operator)`** entrypoint + watch the **`CollateralSeized`** event; surface `defaulted` in state/UI.
- [ ] 🟠 `set_price`: never send a future `updated_ledger` (now rejected).

## 6. Confidential-token preconditions

- [ ] 🔴 Anchor must have a **registered cTBill account with a real `spendable_balance`** (deposit collateral first) — an empty/unregistered account can't produce a valid proof.
- [ ] 🟠 Freeze is **account-level**: while a line is open the anchor's whole cTBill account is frozen (not just the pledged amount). Confirm this matches your product promise; segregated per-amount escrow would be a future contract change (you've frozen contracts, so this is the operating behavior for now).

---

## Is it sellable after all this? — Honest answer: **NO, but it's technically sound.**

After §1–§6 you have a **real, defensible collateralized private-credit primitive**: proof bound to a real owned balance, enforced freeze-escrow, draw bound to the proven amount, and a default/liquidation path. That clears the *technical* credibility bar. It does **not** clear the *commercial* bar. Still missing (all product, not code):

- 🔴 **Supply side** — who funds the cUSDC facility. Nothing above solves this. This is the #1 sell blocker → the **Blend intermediary** model.
- 🔴 **Default *operational* recovery** — the contract emits `CollateralSeized`, but *who actually seizes the confidential collateral and how* (auditor decrypt → transfer out → settle) is an off-chain flow you must build and demo. Lenders won't fund without it.
- 🟠 **Revolving line** vs one-shot positions (anchors want a facility, not single loans) — this *is* a contract change later.
- 🟠 **Unit economics** — the number that proves the anchor saves money.
- 🟠 **Disclosure tiers** for the underwriter/facility.
- 🟠 **Operating & regulatory model** — custodial vs self-hosted (ties to the `sk` decision in §4), lender-of-record vs tech provider.

See `pre-mainnet-readiness.md` Part B for the detail.

---

## Audits still needed

- 🔴 **ZK-circuit audit** — the circuit is the trust root and `collateral_sufficiency` was just rewritten; it needs an independent review. (You have 3 soundness tests; that's not an audit.)
- 🔴 **Soroban contract audit** — contracts changed materially (auth, escrow, liquidation).
- 🟠 **Economic / risk-model review** — LTV, haircut, liquidation feasibility on confidential collateral, backstop sizing.
- 🟠 **Trusted-setup / VK provenance** documentation for the grant.

## Other needs (fast, high-leverage)

- 🟡 **Pause + upgradeability + role separation** — DONE: credit-line `pause`/`unpause`/`paused` + admin-gated `upgrade`; `upgrade` also added to the 3 stateful contracts (lock registry, oracle, repayment registry); **role separation** = admin (pause/upgrade) vs `manager` (open/draw/repay) vs dedicated `liquidator` role (liquidate); **accounting invariant** = `execute_draw` now rejects a draw if the collateral lock isn't active. Remaining: the same 3-line `upgrade` on the config registries (participant/collateral-policy/disclosure); `pauser` role if you want pause off the admin key; the Σ(draws)≤liquidity invariant (needs homomorphic aggregation of hidden amounts — a design item, not a quick add); admin behind a **timelocked multisig** (deploy/ops).
- 🟡 **Tests + CI** — DONE: both product circuits now have soundness tests (`collateral_sufficiency` 3, `repayment_history` 3, all passing) and `.github/workflows/ci.yml` gates contracts (check/test/wasm build) + circuit tests. Remaining: contract-level integration tests (open→draw→repay→liquidate) with mocked cross-contract deps.
- 🟠 **C3** — bind repayment-history proof to on-chain seeded leaves (same class as C1; currently self-attested).
- 🟠 **Real Reflector feed** on mainnet + deviation/staleness breaker.
- 🟠 **Accounting invariant**: Σ(outstanding draws) ≤ facility liquidity; no draw without live escrow.

---

## TL;DR order

1. §1 VK + §2 redeploy + §3 roles → contracts *work* again.
2. §4 prover + §5 API → flow *runs* end-to-end (decide the `sk` custody question here).
3. **Pause switch** (Other needs) + audits → *mainnet-safe*.
4. **Blend supply side + default recovery flow** → *sellable*.
