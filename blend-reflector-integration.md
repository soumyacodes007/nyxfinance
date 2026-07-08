# Nyx — Reflector + Blend Integration (commercial architecture)

This wires Nyx to real Stellar mainnet infrastructure: **Reflector** for pricing and **Blend** for the supply side. Both are implemented as access-controlled Soroban adapters and build clean (`cargo check --workspace`). Live behavior must still be validated on testnet against the real contracts.

---

## 1. Reflector (pricing)

**What:** the oracle adapter can now pull a live SEP-40 price instead of relying on a manually-set number.

**Contract:** `oracle-adapter` gained `refresh_from_reflector(asset, reflector, operator)`:
- calls Reflector `lastprice(Asset::Stellar(asset)) -> Option<PriceData{price:i128, timestamp:u64}>`,
- reads `decimals()` and rescales to the adapter's `price_e7` fixed point,
- stamps `updated_ledger = current ledger` so the credit line's staleness check measures time since Nyx last refreshed.

**Interface (SEP-40):** `Asset::Stellar(Address) | Other(Symbol)`, `lastprice`, `decimals`.
**Mainnet feed:** `CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN` (pass as the `reflector` arg — pick the feed that actually quotes your collateral asset; Reflector runs multiple feeds).

**Still manual `set_price`** remains as a fallback/testnet path. `refresh_from_reflector` is the production path.

---

## 2. Blend (supply side)

**Why:** Nyx doesn't bootstrap its own lending pool. It borrows wholesale liquidity from a **Blend** pool and re-lends it privately to anchors. Blend sees only Nyx's *aggregate* public position; anchor-level amounts stay confidential.

**New contract:** `contracts/blend-facility` (`nyx-blend-facility`) — a thin, access-controlled adapter over Blend's `submit(from, spender, to, requests)`:
- `supply_collateral(from, asset, amount)` — post facility collateral (RequestType 2).
- `borrow(from, to, amount)` — draw wholesale liquidity to fund prefunding (RequestType 4).
- `repay(from, amount)` — repay wholesale debt from anchor repayments (RequestType 5).
- `withdraw_collateral(from, asset, amount, to)` — reclaim collateral (RequestType 3).
- Manager-gated; `from` (the Blend position owner) authorizes each call; admin-gated `upgrade`.

**Interface (verified from `blend-contracts-v2`):**
`Request { request_type: u32, address: Address, amount: i128 }`;
`RequestType { Supply=0, Withdraw=1, SupplyCollateral=2, WithdrawCollateral=3, Borrow=4, Repay=5 }`;
`submit(from, spender, to, requests: Vec<Request>) -> Positions`.

**Mainnet addresses:**
| Contract | Address |
|:--|:--|
| Pool Factory | `CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU` |
| Backstop | `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` |
| BLND token | `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` |
| Comet BLND:USDC | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` |

Pass a specific **lending pool** address (deployed by the Pool Factory) as the facility's `blend_pool` constructor arg, plus the pool's borrow asset (e.g. USDC) as `borrow_asset`. Confirm the pool + asset on the Blend deployments page before mainnet.

---

## 3. The commercial model

```
Anchor (private)
  │  cTBill escrow (freeze) + ZK sufficiency proof
  ▼
PrefundingCreditLine ──draw cUSDC (private)──▶ Anchor payout
  │
Nyx facility treasury
  │  BlendFacility.borrow / repay (public, aggregate)
  ▼
Blend pool  ◀── lenders + backstop (BLND/USDC)
```

**Risk waterfall:** confidential anchor collateral → Nyx facility collateral (posted to Blend) → Blend pool + backstop.

**Cost of funds → unit economics:** anchor rate = Blend borrow rate (utilization-driven) + Nyx origination spread. This gives the anchor a concrete number to compare against idle-USDC and bank lines.

**What Blend hands back to Nyx (owned, not solved by this code):**
1. Confidential-collateral liquidation on anchor default (Blend can't see hidden amounts) — the `liquidate()` + escrow flow.
2. First-loss/backstop capital sizing.
3. Lender-of-record regulatory posture.

---

## 4. Deployment wiring

- [ ] Deploy `blend-facility` with `(admin, manager, blend_pool, borrow_asset)`.
- [ ] Fund + authorize the `from` (Blend position owner) treasury account.
- [ ] Grant the oracle-adapter operator the manager role (already the pattern) and call `refresh_from_reflector` on a schedule (keep price fresh within `max_staleness_ledgers`).
- [ ] Point the collateral policy's `oracle` at the oracle-adapter; keep a refresh cron.
- [ ] Confirm the chosen Blend pool actually lists your borrow asset and has liquidity.

---

## 5. Testnet validation (done)

Deployer `GDVV5DTE…`; Reflector testnet feed `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63`.

- ✅ **All touched contracts build to deployable wasm** (`wasm32v1-none`).
- ✅ **K1** (lock registry access control) — deployed `CAOCQFHN…`; a non-manager `release` is rejected with `Error(Contract, #2000)` and the lock stays active; manager succeeds.
- ✅ **K4** (oracle future-timestamp guard) — `set_price` with a future `updated_ledger` rejected with `Error(Contract, #4302)`; normal `set_price`/`price_e7` round-trips.
- ✅ **Reflector price refresh, LIVE** — deployed oracle `CDT7TAAG…`; `refresh_from_reflector_symbol(BTC)` pulled a real price and stored `price_e7 = 639810032496` ($63,981.00), `updated_ledger = 3486588`. Decimal rescale (14→7) verified against a live number.

**Two real findings from testing:**
1. 🐛 **Reflector asset variant** — the live testnet feed quotes assets by `Other(Symbol)` (BTC, ETH, XLM, USDC…), not `Stellar(Address)`. Added `refresh_from_reflector_symbol` for the symbol path; keep `refresh_from_reflector` (address path) for a Stellar-assets feed.
2. ⚠️ **Stale-wasm risk** — always rebuild before deploy; an earlier deploy used a wasm from a prior session and the K1 test correctly caught it (attacker release *succeeded* on the old wasm).

## 6. Status

- ✅ Reflector adapter — implemented, builds, **testnet-verified with a live price**.
- ✅ Blend facility adapter — implemented, builds, correct request types + submit shape.
- 🟡 **Blend not yet exercised on testnet** — needs a real Blend testnet pool + a funded facility position (`submit` needs pool liquidity + the `from` account's collateral). Deployable; runtime unverified.
- 🟡 **Full credit flow not yet testnet-run** — `open_credit` is proof-gated; blocked on VK regen (`jq`) + prover.
- ❌ Commercial completeness — default recovery flow, backstop model, revolving line, disclosure tiers, regulatory posture (see `pre-mainnet-readiness.md` Part B).

*Sources: Reflector contract & docs (reflector.network, github.com/reflector-network/reflector-contract), SEP-40 (github.com/script3/sep-40-oracle), Blend docs & contracts (docs.blend.capital, github.com/blend-capital/blend-contracts-v2).*
