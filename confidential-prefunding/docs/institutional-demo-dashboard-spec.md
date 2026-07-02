# Nyx Institutional Demo Dashboard Spec

This spec assumes the backend and contract gaps have been fixed:

- SEP-31 starts at `pending_sender` while Alpha is waiting on liquidity.
- SEP-31 can advance to `pending_stellar` after draw/payment submission.
- SEP-31 can advance to `completed` after settlement.
- Nyx product state remains separate from SEP state.
- `execute_draw` performs a real OZ confidential token transfer or transfer-from.
- Auditor decrypt is wired to live draw/repayment auditor ciphertexts.
- Proof generation runs in an Alpha-controlled prover context, or the UI clearly labels the prover as a demo prover.
- Oracle source is clearly marked as Reflector or mock adapter.

The dashboard is for an institutional anchor operator and an institutional observer/auditor. It should not look like a developer debugging portal. Show business state first, cryptographic evidence second, raw hashes last and collapsed.

## Demo Layout

Use a two-browser story:

```txt
Left browser  = Anchor Operator
Right browser = Observer Portal, then Auditor Portal
```

Do not show all roles at once. The strongest moment is the role switch:

```txt
Same position.
Public cannot see amounts.
Auditor loads credential.
Amounts unlock locally.
Repayment history proof unlocks after repayment.
```

## Global UX Rules

- Use business language: payout, liquidity, collateral, risk policy, audit trail.
- Avoid developer-first labels such as `publicInputsHex`, `proofHex`, `contractId`, `ScVal`, `nargo`, `bb` in the main view.
- Keep raw technical evidence available in a collapsed "Verification details" drawer.
- Show public/private boundary explicitly on every screen.
- Never display private amounts in Public Observer mode.
- Never show private keys or custody secrets.
- If using hardcoded demo custody, label it as "Institutional custody profile loaded", not "wallet connected".
- Use transaction hashes, ledgers, and contract events as credibility anchors.

## Shared State Model

Every page should read from the same position state:

```txt
anchor_name: Alpha Remit
anchor_account: Alpha public key
sep31_transaction_id: sep31-alpha-001
payout_corridor: USD -> PHP
payout_amount: 50,000 cUSDC
settlement_window_days: 3
collateral_asset: cTBill
collateral_amount_private: 250,000 cTBill
draw_amount_private: 50,000 cUSDC
fee_private: 142 cUSDC
repayment_amount_private: 50,142 cUSDC
tenor_days: 3
due_date: Jul 5, 2026
```

Keep statuses separate:

```txt
SEP-31 status:
pending_sender -> pending_stellar -> completed

Nyx product status:
prefunding_required -> quote_ready -> proof_generating -> proof_verified -> credit_drawn -> repaid -> closed
```

## Left Browser: Anchor Operator

### Page 1: Payout Need

Purpose: establish that this is a real anchor liquidity need, not a generic loan screen.

Show only:

```txt
Header: Alpha Remit
Subtitle: Institutional payout operator

SEP-31 Transaction: sep31-alpha-001
SEP Status: pending_sender
Product Status: Prefunding required
Payout corridor: USD -> PHP
Payout amount: 50,000 cUSDC
Settlement window: 3 days
KYB: Approved
Custody profile: Alpha institutional custody loaded
```

Primary CTA:

```txt
Review collateral
```

Secondary evidence, collapsed:

```txt
Anchor account
SEP-31 transaction record
SEP-12 customer ID
ParticipantPolicy approval tx hash
```

Do not show:

```txt
Contract internals
Proof fields
Private collateral amount
Private repayment history
```

### Page 2: Collateral Vault

Purpose: show Alpha has eligible private collateral without revealing reserves.

Show only:

```txt
Collateral asset: cTBill
Eligibility: Eligible
Policy source: CollateralPolicyRegistry
Oracle: Fresh
Oracle source: Reflector or Mock Oracle Adapter
Haircut: 10%
Maximum tenor: 5 days
Public visibility: Hidden
Collateral amount: Private
```

Primary CTA:

```txt
Request prefunding
```

Verification drawer:

```txt
CollateralPolicyRegistry contract
OracleAdapter contract
Oracle updated ledger
Policy read status
```

If oracle is still mock, show a visible but non-alarming badge:

```txt
Oracle source: Demo adapter
```

Do not hide mock oracle behind a generic "Fresh" label.

### Page 3: Private Prefunding Request

Purpose: show quote and proof request in institutional terms.

Show:

```txt
Requested draw: 50,000 cUSDC
Tenor: 3 days
Collateral asset: cTBill
Haircut: 10%
Estimated fee: 142 cUSDC
Due date: Jul 5, 2026
Eligibility: Passed
```

Primary CTA:

```txt
Verify private collateral
```

Proof generation UX must be explicit and credible:

```txt
State 1: Preparing private witness
State 2: Generating collateral sufficiency proof
State 3: Submitting proof to Stellar
State 4: Verifier accepted proof
```

Copy:

```txt
Alpha proves the private cTBill position covers the requested cUSDC draw after haircut.
Nyx verifies the proof without revealing reserve size.
```

If proof generation is backend/prover-worker:

```txt
Prover: Alpha demo prover
```

If proof generation is browser/local:

```txt
Prover: Local browser session
```

Do not say:

```txt
Backend never sees amounts
```

unless proving has actually moved out of backend custody.

Technical drawer after success:

```txt
Proof system: Noir + UltraHonk
Verifier contract
Proof tx hash
Opened ledger
Position nullifier
Collateral commitment
Credit commitment
```

### Page 4: Credit Opened And Draw

Purpose: prove that private liquidity was released against verified collateral.

Show before draw:

```txt
Credit line: Open
Collateral lock: Active
Proof status: Verified
Draw status: Ready
```

Primary CTA:

```txt
Draw 50,000 cUSDC
```

Show after draw:

```txt
cUSDC released: Complete
Confidential transfer: Confirmed
Collateral lock: Active
SEP Status: pending_stellar
Product Status: credit_drawn
```

Technical drawer:

```txt
CreditOpened tx hash
DrawExecuted tx hash
OZ confidential transfer tx hash
Transfer commitment
Auditor ciphertext event ID
Closed ledger or latest ledger
```

The key credibility point:

```txt
Draw must reference a real OZ ConfidentialToken transfer event.
```

If `execute_draw` only emits `DrawExecuted`, the UI must not say "cUSDC released". It should say:

```txt
Draw intent recorded
```

### Page 5: Repayment

Purpose: close the credit line cleanly and feed repayment history.

Show:

```txt
Outstanding repayment: 50,142 cUSDC
Due date: Jul 5, 2026
Status: On time
Collateral lock: Active
```

Primary CTA:

```txt
Repay credit line
```

After repayment:

```txt
Repayment: Confirmed
SEP Status: completed
Product Status: repaid
Collateral lock: Released
Repayment history: Updating
```

Technical drawer:

```txt
Repaid tx hash
Repayment commitment
Closed ledger
Collateral lock release status
Repayment leaf nullifier
```

## Right Browser: Public Observer

### Page 1: Public Position View

Purpose: prove privacy boundary before the auditor unlock.

Show:

```txt
Anchor: Alpha Remit
SEP-31 Transaction: sep31-alpha-001
Position status: Active or Repaid
Collateral type: cTBill
Proof status: Verified
Tenor: 3 days
Public visibility: Amounts hidden
```

Show hidden fields deliberately:

```txt
Collateral amount: Hidden
Draw amount: Hidden
Reserve size: Hidden
LTV: Hidden
Repayment amount: Hidden
Counterparties: Hidden
```

Verification drawer:

```txt
CreditOpened event
DrawExecuted event
Repaid event
Proof verifier contract
Position nullifier
Commitments
```

Do not show:

```txt
250,000 cTBill
50,000 cUSDC
142 cUSDC
50,142 cUSDC
```

### Page 2: Public Proof View

Purpose: make the public proof meaningful without leaking data.

Show:

```txt
Collateral sufficiency: Verified
Policy: Satisfied
Oracle freshness: Satisfied
Tenor policy: Satisfied
Replay protection: Nullifier used
```

Hidden values:

```txt
Private collateral amount: Hidden
Private draw amount: Hidden
Private randomness: Hidden
Private reserve ratio: Hidden
```

This page should feel like a compliance attestation, not a block explorer.

## Right Browser: Auditor Mode

### Auditor Unlock

Purpose: create the strongest demo moment.

Toggle:

```txt
Public Observer -> Auditor
```

CTA:

```txt
Load demo auditor credential
Decrypt audit trail
```

Unlock states:

```txt
Loading auditor credential
Fetching encrypted event payloads
Decrypting locally
Audit trail unlocked
```

Important wording:

```txt
The same public position becomes readable only with the authorized auditor credential.
```

### Auditor Trail

Purpose: show full facts after authorization.

Show:

```txt
Anchor: Alpha Remit
Position: Active or Repaid
Collateral amount: 250,000 cTBill
Draw amount: 50,000 cUSDC
Haircut: 10%
Fee: 142 cUSDC
Repayment amount: 50,142 cUSDC
Due date: Jul 5, 2026
Closed ledger: <ledger>
Collateral lock: Released
```

Event timeline:

```txt
1. KYB approved
2. ParticipantPolicy approved Alpha
3. Collateral proof verified
4. Credit line opened
5. Confidential cUSDC draw executed
6. Auditor ciphertext emitted
7. Repayment confirmed
8. Collateral lock released
```

Technical drawer:

```txt
Auditor ciphertext IDs
Decryption result hash
CreditOpened tx hash
DrawExecuted tx hash
OZ transfer tx hash
Repaid tx hash
```

Do not show auditor private key.

## Right Browser: Repayment History Proof

Purpose: show the second circuit is about private history, not the current credit line only.

Show:

```txt
Repayment history root: Updated
Proof: prove_repayment_history
Status: Verified
Statement: Alpha has at least 3 on-time repayments
Amounts: Hidden
Dates: Hidden
Counterparties: Hidden
```

CTA:

```txt
Generate history proof
```

Proof states:

```txt
Collecting private repayment leaves
Generating repayment history proof
Submitting proof to verifier
Proof verified on Stellar
```

Technical drawer:

```txt
RepaymentHistoryRootSet tx hash
RepaymentHistoryVerified tx hash
History root
Proof nullifier
Verifier contract
```

Do not show the three repayment amounts or dates in the public proof area. Auditor mode may show scoped private facts if the scope allows it.

## Right Browser: Selective Disclosure

Purpose: show scoped sharing without turning the backend into the privacy source of truth.

Show:

```txt
Disclosure scope: Repayment status only
Viewer: Accountant / Lender
Grant status: Active
Expiry: <ledger or readable time>
Revocation: Available
```

Visible scoped result:

```txt
Repayment status: On time threshold met
On-time repayments: >= 3
Position: Repaid
```

Do not show:

```txt
Collateral amount
Draw amount
Full repayment amounts
Full counterparties
Auditor key
Plaintext bundle from backend
```

Verification drawer:

```txt
DisclosureGrantCreated tx hash
Grant ID
Viewer hash
Scope hash
Bundle hash
Expiry ledger
Revoked flag
```

## What To Hardcode

Hardcode these for demo stability:

```txt
Alpha Remit name
Payout corridor
Payout amount
Settlement window
Demo public account labels
Demo auditor credential button
Demo viewer/disclosure session
Institutional custody profile label
```

Do not hardcode these if the backend can provide them:

```txt
SEP status
Product status
Quote result
Proof job status
Proof verification result
CreditOpened tx hash
DrawExecuted tx hash
OZ transfer tx hash
Repaid tx hash
Watcher events
Disclosure grant status
```

## Wallet And Custody UX

This is not a retail wallet demo. Do not use "Connect wallet" as the central UX.

Use:

```txt
Custody profile: Alpha institutional custody loaded
Signing authority: Backend operator signer
Authorization: SEP-10 / operator policy
```

Optional technical drawer:

```txt
Anchor public key
Operator public key
Last signed transaction hash
```

Never show:

```txt
Secret key
Seed phrase
Raw signing payload by default
```

Freighter is not required for credibility here. For institutional anchors, server-side custody or HSM-style signing is normal. Credibility should come from real ledgers, tx hashes, event logs, and verifier contracts.

## Proof UX Requirements

Yes, proof generation needs proper UX. The user must understand that something real happened.

Minimum proof component:

```txt
Title: Private collateral proof
Status: Not started / Generating / Verified / Failed
Statement: Collateral covers requested draw after haircut
Privacy: Amounts stay hidden
Verifier: Stellar contract
```

Progress states:

```txt
Preparing witness
Generating Noir proof
Submitting UltraHonk proof
Verifier accepted proof
Position opened
```

Success state:

```txt
Private collateral verified
Policy satisfied
No reserve amount disclosed
```

Failure state:

```txt
Proof rejected
Reason: Collateral insufficient / stale oracle / policy mismatch / replayed nullifier
```

Technical details must be collapsed:

```txt
Proof job ID
Verifier contract
Proof tx hash
Public inputs hash
Nullifier
Commitment IDs
```

## Demo Script Mapping

Use this table to keep the frontend aligned with the talk track.

| Demo step | Left browser | Right browser |
|---|---|---|
| 1. Real payout need | Payout Need page | Closed or public landing |
| 2. Private collateral | Collateral Vault page | Public Position View |
| 3. Public cannot see reserves | No action | Public Position View hidden fields |
| 4. Request and prove credit | Private Prefunding Request page | Public Proof View |
| 5. Public still sees no amounts | No action | Public Proof View |
| 6. Draw cUSDC | Credit Opened And Draw page | Public Position View updates active |
| 7. Public sees active position | No action | Public Position View |
| 8. Switch to auditor | No action | Auditor Unlock |
| 9. Auditor sees full trail and repayment | Repayment page | Auditor Trail live update |
| 10. Repayment history proof | No action | Repayment History Proof |
| 11. Selective disclosure | Optional | Selective Disclosure |

## Main Readiness Rule

The UI can be simple, but the story must never overclaim.

Use this if everything is live:

```txt
Nyx verified private collateral, opened credit, released cUSDC confidentially, and produced an auditor-readable trail.
```

Use this if the draw transfer is still not wired to OZ ConfidentialToken:

```txt
Nyx verified private collateral and recorded a draw commitment. The confidential cUSDC transfer integration is the next production step.
```

Use this if proof is still generated by backend prover-worker:

```txt
For demo, the Alpha prover-worker generates the proof. In production this prover runs under Alpha custody.
```

