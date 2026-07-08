# Nyx — Security & Optimization Audit

Scope: Soroban contracts under `oz-confidential/contracts/*` and Noir circuits under `oz-confidential/circuits/*`, reviewed against the product claims in `README.md`.

Review type: manual source audit + `cargo` build verification + `nargo info` constraint analysis. Testnet only.

**Coverage (full pass):** all 14 Soroban contracts and all 16 Noir circuits/gadgets reviewed. The 6 OpenZeppelin confidential-token circuits (`register`, `withdraw`, `transfer`, `set_spender`, `spender_transfer`, `revoke_spender`) are well-constrained and sound — proper ownership (`Y = sk·H`), 127-bit range checks, and public-input point validation. **They are the reference template and must not be modified** (any change breaks their verification keys and the confidential token). All findings below concern the two *product* circuits (`collateral_sufficiency`, `repayment_history`) and the Nyx contracts.

## Fix status

Applied and build-verified (`cargo check --workspace` passes): **K1, K3, K4, K5, K6, K7, O1, O2**.
**F1/C1 — implemented and verified on-chain + in-circuit:** `collateral_sufficiency` v2 now proves account ownership (`Y = sk·H`) and opens the anchor's *real* `spendable_balance` commitment; `open_credit` sources `c_spend` + `Y` from the confidential token's `confidential_balance()` and rejects prover-supplied commitments. 3 `nargo` soundness tests pass (accept valid; reject wrong-owner; reject-insufficient). **Remaining to ship F1:** regenerate the VK bytes (`bb write_vk`, needs `jq` in CI — public-input count changed 9→11), redeploy `CollateralSufficiencyVerifier` with the new VK, and update the off-chain prover to supply the new witness (`sk`, balance opening) and drop the two removed `open_credit` args.
Deferred by decision: **O3** (would break backend ABI), **O4** (cosmetic).
Open — require escrow design / separate circuit: **F2** (real escrow/liquidation), **K2** (bind draw to proven credit), **C2** (explicit range bounds — folded into C1 circuit), **C3** (repayment-history binding).

---

## Summary table

| ID | Severity | Area | Finding | Source |
|:--|:--|:--|:--|:--|
| F1 | 🔴 Critical | Circuit | Collateral proof not bound to real on-chain balance/ownership | You |
| F2 | 🔴 Critical | Contract | No real collateral escrow/freeze/liquidation — "lock" is a flag | You |
| K1 | 🔴 Critical | Contract | `CollateralLockRegistry.lock`/`release` have no access control | Me |
| C1 | 🔴 Critical | Circuit | `collateral_sufficiency` has no ownership/ledger binding, no range checks | Me (= F1 at circuit level) |
| C3 | 🟠 High | Circuit | `repayment_history` root is self-attested, not bound to on-chain repayments | Me |
| K2 | 🟠 High | Contract | Draw amount unbound to the proven credit commitment | Me |
| K3 | 🟠 High | Contract | No `anchor.require_auth()` — full trust in one operator key | Me |
| C2 | 🟡 Medium | Circuit | Unbounded `u128` multiply → legit-prover completeness/DoS hazard | Me |
| K4 | 🟡 Medium | Contract | Oracle freshness defeatable via attacker/future `updated_ledger` | Me |
| K5 | 🟡 Medium | Contract | Replay/lock persistent state has no TTL management | Me |
| K6 | 🟡 Low | Contract | Checks-effects-interactions ordering in `open_credit` | Me |
| K7 | ⚪ Cosmetic | Contract | Wrong error code on missing leaf; meaningless `bool` return | Me |
| O1 | 🟢 Optimization | Contract | 5 policy cross-calls collapsible to 1 | Me |
| O2 | 🟢 Optimization | Contract | Oracle read twice, collapsible to 1 | Me |
| O3 | 🟢 Optimization | Contract | Redundant `public_inputs: Bytes` parameter | Me |
| O4 | 🟢 Optimization | Contract | Hardcoded `tenor_days > 5` duplicates policy | Me |

Legend: 🔴 critical · 🟠 high · 🟡 medium/low · ⚪ cosmetic · 🟢 optimization

---

## What you found

### F1 — Proof is not bound to real collateral 🔴 (Importance 10/10)
The ZK proof proves *"I know some private collateral amount"* but **not** *"that amount is my on-chain confidential balance."* Without binding the proof to live ledger state, the proof is not economically meaningful — no lender/anchor/reviewer should trust it.

**Confirmed.** See C1 for the circuit-level evidence.

### F2 — No actual collateral pledge / escrow / freeze 🔴 (Importance 10/10)
Collateral is represented only by a hash lock while the borrower keeps control of the asset. A real credit product requires:
- open credit → collateral escrowed/frozen
- repay → collateral released
- default → lender/facility can claim or liquidate

Without this, Nyx is not truly collateral-backed.

**Confirmed.** `open_credit` → `lock_collateral` → `CollateralLockRegistry.lock` performs a single storage write (`collateral-lock-registry/src/lib.rs:57`). No token transfer, freeze, or escrow. Grep across the credit line + lock registry returns **zero** references to `transfer`/`freeze`/`escrow`/`balance`. `release` just flips `active = false`. **There is no default/liquidation path anywhere** — `expiry_ledger` is stored but never enforced. The `confidential-token` contract has `freeze`/`unfreeze`, but the credit line never calls them.

---

## What I found

### The reference model (why the gaps are precise)
`transfer/src/main.nr` is the template the product circuits do **not** follow:
- **T1** `Y_A = sk_A * H` — proves ownership of the spending key.
- **T3** `C_spend^A = v*G + r*H`, with the commitment loaded by the contract **from `from.spendable_balance`** (ledger state, not a witness).
- **T4** `v.assert_max_bit_size::<127>()` on every amount.

A transfer proof can't be forged: the balance comes from storage and ownership is proven. The product circuits below miss all three protections.

---

### K1 — `CollateralLockRegistry.lock`/`release` have no access control 🔴
`collateral-lock-registry/src/lib.rs:45,69`

```rust
pub fn lock(e, lock_key, owner, collateral_token, position_id, expiry_ledger, _operator: Address) { ... }
pub fn release(e, lock_key, _operator: Address) { ... }
```

`_operator` is accepted and **discarded** — no `#[only_role]`, no `require_auth`, no check that the caller is `PrefundingCreditLine`. In Soroban a cross-contract call does not authenticate the caller, so a direct external call from any funded account behaves identically to the credit line's call.

- **Exploit 1 (collateral escapes):** anyone calls `release(lock_key)` on a live position's lock. The lock is meant to be held until repayment; releasing early destroys the one invariant the product sells and lets the same `lock_key` be reused in a new `open_credit`.
- **Exploit 2 (griefing):** anyone pre-calls `lock(target_lock_key, ...)`. `lock_key` is deterministic and bound in the proof's public inputs, so an observer can front-run and make a legitimate `open_credit` revert with `LockAlreadyUsed`.

**Fix:** gate both with `#[only_role(operator, "manager")]` like every other mutator in the repo, and grant the credit line the `manager` role on the registry.

---

### C1 — `collateral_sufficiency` has no ownership/ledger binding, no range checks 🔴 (= F1)
`collateral_sufficiency/src/main.nr:20-55`

`collateral_amount` and `credit_amount` are **free private witnesses**. The circuit:
- has **no** `Y = sk*H` ownership constraint (unlike register R1 / transfer T1),
- **never** loads the commitment from the cTBill contract (unlike transfer's `c_spend` from `from.spendable_balance`),
- has **no** `assert_max_bit_size` range checks (unlike transfer T4).

A prover can input `collateral_amount = 999_999_999` with fresh randomness and the proof verifies. The contract `open_credit` also never reads a confidential balance.

**Fix:** rebuild the circuit on the same primitives `transfer` uses — prove `Y = sk*H`, and make `collateral_commitment` the anchor's *actual* cTBill balance commitment loaded from the confidential-token contract, not a witness.

---

### C3 — `repayment_history` root is self-attested 🟠
`repayment_history/src/main.nr` + `repayment-history-registry/src/lib.rs:122`

The circuit takes 3 leaves as free witnesses, hashes them to `derived_root`, and asserts equality with the public `history_root`. But `set_history_root` lets the manager set the root to **any value**, and the circuit's leaf hash `Poseidon(DOMAIN_REPAYMENT_LEAF, …)` is a **different** value than the `leaf_nullifier` the registry stores in `seed_leaf`. Nothing links the proof's leaves to the seeded leaves or to real `Repaid` events. The same operator sets the root and proves knowledge of its preimages — circular.

**Fix:** make the circuit leaf hash equal the on-chain `leaf_nullifier`, and have the contract verify each proven leaf exists in storage.

---

### K2 — Draw amount unbound to the proven credit commitment 🟠
`prefunding-credit-line/src/lib.rs:239`

`execute_draw` takes an arbitrary `transfer_commitment` with no relation to the proof's `credit_commitment`. The proof constrains a credit amount; the actual cUSDC movement is a separate operator-chosen value. The proven "collateral ≥ credit" never reaches the money.

---

### K3 — No `anchor.require_auth()` 🟠
`open_credit`/`execute_draw`/`repay` are `#[only_role(manager)]` only; `anchor` is an operator-supplied parameter. System integrity reduces entirely to trusting the single `CREDIT_EXECUTOR` key. This is a centralized-executor trust model — state it explicitly; the privacy layer hides amounts from the public but does **not** trust-minimize the operator.

---

### C2 — Unbounded `u128` multiply (completeness/robustness) 🟡
`collateral_sufficiency/src/main.nr:53-54`

```rust
let collateral_value = collateral_amount * oracle_price_e7 * effective_bps; // three u128s
let required_value   = credit_amount * 10_000 * 10_000_000;
```

**Not** a soundness hole — Noir overflow-checks `u128` multiplication, so a malicious prover can't wrap it to force a false `>=`. But with high-priced assets or high-decimal tokens, a **legitimate** prover with sufficient collateral can exceed 2^128 and be unable to prove at all. Add explicit `assert_max_bit_size` bounds on the inputs (same discipline as transfer T4) so the safe domain is explicit and products stay in range.

---

### K4 — Oracle freshness is defeatable 🟡
`oracle-adapter/src/lib.rs:44` + `prefunding-credit-line/src/lib.rs:390`

`set_price` accepts an arbitrary `updated_ledger`; `oracle_fresh` uses `saturating_sub`, so a **future** `updated_ledger` yields staleness 0 → always "fresh." Stamp `updated_ledger = e.ledger().sequence()` on-chain instead of trusting the parameter.

---

### K5 — Replay/lock persistent state has no TTL management 🟡
`UsedNullifier`, `Position`, `Lock` live in persistent storage, but the contracts never call `extend_ttl`. Replay protection and locks are security-critical; relying on default TTL without bumping it invites archival edge cases and forced-restore costs over a position's life. Bump TTL on these entries when written.

---

### K6 — Checks-effects-interactions ordering 🟡
`open_credit` performs all external `invoke_contract` calls (policy/oracle/verifier/lock) **before** writing `UsedNullifier`/`Position`. Targets are admin-set (your own contracts, no callbacks), so it's low risk today — but if a verifier/oracle address is ever swapped for something with a callback, the top-level nullifier check could be re-passed reentrantly. Write nullifier/position state before the external verifier call, or keep verifier addresses immutable.

---

### K7 — Cosmetics ⚪
- `RepaymentHistoryRegistry::leaf` returns `DuplicateLeaf` on *not found* (`repayment-history-registry/src/lib.rs:199`) — should be a "not found" error.
- `verify_history` returns `bool` but only ever returns `true` or panics — the return value is meaningless.

---

## Optimizations

### O1 — Collapse 5 policy cross-calls into 1 🟢 (biggest win)
`open_credit` invokes the collateral registry **five times** (`collateral_max_tenor`, `collateral_eligible`, `collateral_oracle`, `collateral_max_staleness`, `collateral_haircut`), each re-running `Self::policy()` (storage read + struct deserialize). The registry already exposes `policy(token) -> CollateralPolicy`. Call it once, bind all fields locally. Cross-contract invocations are heavily metered — removes ~4 invocations + 4 redundant struct loads per open.

### O2 — Fetch oracle `price()` once 🟢
`oracle_price` and `oracle_fresh` each invoke the oracle and each re-load `PriceData`. Call `price()` once and use both `price_e7` and `updated_ledger` from the single struct.

### O3 — Drop the redundant `public_inputs: Bytes` parameter 🟢
`open_credit` (and `verify_history`) accept `public_inputs` **and** all the fields, rebuild the bytes, then assert equality. Build the bytes in-contract and pass them straight to the verifier — saves transaction size, an O(n) `Bytes` compare, and a "did the caller encode it right" surface.

### O4 — Remove duplicated tenor ceiling 🟢
The hardcoded `tenor_days > 5` in the credit line duplicates the policy's `max_tenor_days <= 5`. Rely on `> max_tenor` alone unless a global ceiling independent of policy is intended.

---

## Circuit audit — full coverage, constraint data & the cost story

Measured with `nargo info` (nargo 1.0.0-beta.11):

| Circuit | ACIR opcodes | What it spends them on |
|:--|:--|:--|
| `collateral_sufficiency` (product) | **126** | two standalone Pedersen commitments + nullifier + u128 compare |
| `repayment_history` (product) | **90** | 3 leaf hashes + root + nullifier + on-time counting |
| `transfer` (OZ reference) | **129** | ownership + range + ECDH + dual auditor channels + balances |

**Key finding for both soundness and budget:** `collateral_sufficiency` already costs almost exactly what `transfer` costs (126 vs 129), while doing far less — because two free-floating Pedersen commitments dominate its gate count. The C1 fix (bind to the real cUSDC/cTBill balance + prove ownership) does **not** roughly double the circuit. It *repurposes* the commitment already computed: the collateral commitment stops being a standalone witness and **becomes** the account's `C_spend` balance commitment (as in `transfer` T3), with ownership added via `Y = sk·H` (T1) and range checks (T4). Net effect: the soundness rewrite is close to **cost-neutral in gate count**, and on-chain UltraHonk verification cost is constant regardless — so **making the proof sound does not raise the mainnet fee.**

**Optimization verdict for circuits:** do *not* micro-optimize the product circuits now. They are already `transfer`-scale, verification is constant-cost, and the C1/C3 soundness rewrite will replace them anyway — fold the efficiency work into that rewrite (reuse the balance commitment; don't add a second one). The OZ circuits are sound and off-limits. The only optimizations worth applying at the contract layer (O1/O2) are already done.

**C2 note (unbounded multiply):** the `lte_hint`/`decompose_hint` Brillig in `collateral_sufficiency` is the u128 comparison machinery. Adding explicit `assert_max_bit_size` bounds (per C1) makes the safe input domain explicit at negligible extra cost and removes the legit-prover overflow hazard.

---

## Recommended priority

1. **K1** — trivial fix, highest exploitability (add the role gate).
2. **C1 / F1** — bind the collateral proof to real balance + ownership; **C3** is the same fix for repayment history.
3. **F2 / K2** — make the pledge enforceable (real escrow/freeze on open, release on repay, liquidation on default) and bind the draw to the proven amount.
4. **O1–O3** — free performance + smaller attack surface while already editing `open_credit`.
5. **C2, K4–K7** — hardening.

---

## Honest product framing

As written, Nyx is a **privacy-preserving *display* of a solvency claim**, not a collateral-backed credit system. That is a legitimate demo/hackathon framing — but it must not be described to a lender, anchor, or technical reviewer as collateral-enforced, because opening `collateral_sufficiency/src/main.nr` reveals the free `collateral_amount` witness immediately. Fixing F1/C1 (binding) then F2 (escrow) is what turns the claim true.

*Contracts and registries other than the lock registry are consistently well-gated with `#[only_role(operator, "manager")]`; the public-input byte encoding between contract and circuit is consistent; and the position/proof nullifier design correctly prevents third-party precomputation. The gaps above are about binding proofs to real state and enforcing the pledge — not about the crypto plumbing being wrong.*
