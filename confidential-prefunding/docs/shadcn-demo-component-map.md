# Nyx Demo shadcn Component Map

Goal: maximize consistency across the institutional demo UI by reusing a small shadcn component set everywhere. This is not a page-by-page custom design exercise. Build one product language, then compose it across Anchor Operator, Public Observer, and Auditor modes.

## Component Policy

Use shadcn as the base for structure and behavior:

```txt
Button
Card
Badge
Tabs
Accordion
Dialog
Sheet
Table
Separator
Progress
Skeleton
Alert
Tooltip
Dropdown Menu
Command
Input
Label
Textarea
Switch
Scroll Area
Toast / Sonner
```

Avoid adding new component families unless there is a clear need. If one page needs a pattern, make it reusable first.

## Shared App Shell

Use the same shell for both browsers.

Components:

```txt
Card
Badge
Button
Separator
Dropdown Menu
Tooltip
Sheet
Scroll Area
```

Layout elements:

```txt
Top status bar
Role switcher
Primary content column
Right-side evidence panel
Collapsed verification drawer
Global toast area
```

Shared status bar fields:

```txt
Network: Stellar Testnet / Localnet
Anchor: Alpha Remit
SEP-31: pending_sender / pending_stellar / completed
Nyx: prefunding_required / proof_verified / credit_drawn / repaid
Custody: Institutional custody loaded
```

Use `Badge` variants consistently:

```txt
success: approved, verified, completed, fresh
warning: pending_sender, pending_stellar, generating
danger: rejected, failed, expired, stale
neutral: hidden, private, not_started
outline: contract, tx, ledger metadata
```

## Reusable Domain Components

Build these once and reuse across pages.

### `StatusBadge`

Use shadcn:

```txt
Badge
Tooltip
```

Purpose:

```txt
Render SEP status, product status, proof status, oracle status, lock status.
```

Never hand-style status pills per page.

### `MetricCard`

Use shadcn:

```txt
Card
Badge
Tooltip
Skeleton
```

Purpose:

```txt
Business metric with label, value, optional status, optional helper text.
```

Examples:

```txt
Payout amount: 50,000 cUSDC
Tenor: 3 days
Fee: 142 cUSDC
Collateral amount: Hidden
```

### `HiddenValue`

Use shadcn:

```txt
Badge
Tooltip
```

Purpose:

```txt
Show hidden/private fields without making them look like missing data.
```

Text:

```txt
Hidden
Private
Encrypted
Auditor only
```

### `VerificationDrawer`

Use shadcn:

```txt
Accordion
Table
Badge
Button
Tooltip
Scroll Area
```

Purpose:

```txt
Collapsed technical proof, contract, transaction, ledger, and event details.
```

This keeps the main dashboard institutional, not developer-heavy.

### `Timeline`

Use shadcn:

```txt
Card
Badge
Separator
Tooltip
```

Purpose:

```txt
KYB approved
Policy synced
Quote generated
Proof verified
Credit opened
Draw executed
Repayment confirmed
Disclosure created
```

### `ProofProgress`

Use shadcn:

```txt
Card
Progress
Badge
Alert
Skeleton
Button
```

States:

```txt
not_started
preparing_witness
generating_proof
submitting_to_stellar
verified
failed
```

Use this for both collateral sufficiency and repayment history proof.

### `ActionPanel`

Use shadcn:

```txt
Card
Button
Alert
Dialog
Toast / Sonner
```

Purpose:

```txt
Primary action per page with confirmation and result feedback.
```

One primary CTA per page.

### `TxReceipt`

Use shadcn:

```txt
Card
Badge
Button
Tooltip
Accordion
```

Purpose:

```txt
Show tx hash, ledger, contract, event name, and explorer/RPC link.
```

Main view should show short tx hash only. Full hash belongs in drawer.

### `RoleGate`

Use shadcn:

```txt
Tabs
Button
Alert
Dialog
Input
Label
```

Purpose:

```txt
Switch Public Observer to Auditor and require demo auditor credential.
```

Do not show auditor data before unlock.

## Page 1: Anchor Operator / Payout Need

Primary components:

```txt
Card
Badge
Button
Separator
Accordion
Table
Skeleton
Alert
```

Reusable components:

```txt
StatusBadge
MetricCard
ActionPanel
VerificationDrawer
Timeline
```

Main sections:

```txt
Payout summary card
SEP-31 status card
KYB / ParticipantPolicy card
Next action panel
Verification drawer
```

Visible fields:

```txt
Alpha Remit
SEP-31 Transaction: sep31-alpha-001
SEP Status: pending_sender
Product Status: prefunding_required
Payout corridor: USD -> PHP
Payout amount: 50,000 cUSDC
Settlement window: 3 days
KYB: Approved
Custody profile: Institutional custody loaded
```

Primary CTA:

```txt
Review collateral
```

Verification drawer rows:

```txt
Anchor account
SEP-31 transaction ID
SEP-12 customer ID
ParticipantPolicy tx hash
Latest ledger
```

Consistency rule:

```txt
Use MetricCard for all summary fields. Do not make custom payout rows.
```

## Page 2: Anchor Operator / Collateral Vault

Primary components:

```txt
Card
Badge
Button
Tooltip
Accordion
Table
Alert
```

Reusable components:

```txt
MetricCard
HiddenValue
StatusBadge
ActionPanel
VerificationDrawer
```

Main sections:

```txt
Collateral eligibility
Oracle freshness
Policy terms
Privacy boundary
Verification drawer
```

Visible fields:

```txt
Collateral asset: cTBill
Eligibility: Eligible
Oracle: Fresh
Oracle source: Reflector or Demo adapter
Haircut: 10%
Max tenor: 5 days
Collateral amount: Hidden
Public visibility: Hidden
```

Primary CTA:

```txt
Request prefunding
```

Verification drawer rows:

```txt
CollateralPolicyRegistry
OracleAdapter
Oracle updated ledger
Haircut read result
Eligibility read result
```

Consistency rule:

```txt
Always show oracle source as a Badge. Never bury mock/Reflector status in JSON.
```

## Page 3: Anchor Operator / Private Prefunding Request

Primary components:

```txt
Card
Badge
Button
Progress
Alert
Accordion
Table
Dialog
Toast / Sonner
```

Reusable components:

```txt
MetricCard
ProofProgress
ActionPanel
VerificationDrawer
TxReceipt
```

Main sections:

```txt
Quote summary
Proof progress
Policy checks
Result receipt
Verification drawer
```

Visible fields:

```txt
Requested draw: 50,000 cUSDC
Tenor: 3 days
Collateral: cTBill
Haircut: 10%
Estimated fee: 142 cUSDC
Due date: Jul 5, 2026
Status: Eligible
```

Primary CTA:

```txt
Verify private collateral
```

ProofProgress labels:

```txt
Preparing witness
Generating Noir proof
Submitting UltraHonk proof
Verifier accepted proof
Position opened
```

Failure Alert examples:

```txt
Collateral insufficient
Oracle price stale
Policy mismatch
Nullifier already used
Verifier rejected proof
```

Verification drawer rows:

```txt
Proof job ID
Verifier contract
Proof tx hash
Position nullifier
Collateral commitment
Credit commitment
Public inputs hash
```

Consistency rule:

```txt
Do not expose proofHex or publicInputsHex in main content.
```

## Page 4: Anchor Operator / Credit Draw

Primary components:

```txt
Card
Badge
Button
Progress
Alert
Accordion
Table
Toast / Sonner
Dialog
```

Reusable components:

```txt
MetricCard
StatusBadge
ActionPanel
Timeline
TxReceipt
VerificationDrawer
```

Main sections:

```txt
Credit line status
Collateral lock status
Draw action
Confidential transfer status
Receipts
```

Before draw visible fields:

```txt
Credit line: Open
Proof status: Verified
Collateral lock: Active
Draw status: Ready
SEP Status: pending_sender
```

Primary CTA:

```txt
Draw 50,000 cUSDC
```

After draw visible fields:

```txt
cUSDC released: Complete
Confidential transfer: Confirmed
Collateral lock: Active
SEP Status: pending_stellar
Product Status: credit_drawn
```

Verification drawer rows:

```txt
CreditOpened tx hash
DrawExecuted tx hash
OZ ConfidentialToken tx hash
Transfer commitment
Auditor ciphertext event ID
Ledger
```

Consistency rule:

```txt
If the OZ transfer is not confirmed, show "Draw intent recorded", not "cUSDC released".
```

## Page 5: Anchor Operator / Repayment

Primary components:

```txt
Card
Badge
Button
Alert
Accordion
Table
Progress
Toast / Sonner
```

Reusable components:

```txt
MetricCard
StatusBadge
ActionPanel
Timeline
TxReceipt
VerificationDrawer
```

Main sections:

```txt
Repayment summary
Due date and status
Repayment action
Collateral release status
Receipts
```

Visible fields before repayment:

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

Visible fields after repayment:

```txt
Repayment: Confirmed
SEP Status: completed
Product Status: repaid
Collateral lock: Released
Repayment history: Updating
```

Verification drawer rows:

```txt
Repaid tx hash
Repayment commitment
Closed ledger
Collateral lock release status
Repayment leaf nullifier
```

Consistency rule:

```txt
Use the same TxReceipt component used on draw/open. Do not create a repayment-only receipt card.
```

## Page 6: Public Observer / Public Position View

Primary components:

```txt
Card
Badge
Tabs
Accordion
Table
Tooltip
Alert
```

Reusable components:

```txt
MetricCard
HiddenValue
StatusBadge
Timeline
VerificationDrawer
```

Main sections:

```txt
Public position summary
Hidden values grid
Proof attestation
Event timeline
Verification drawer
```

Visible fields:

```txt
Anchor: Alpha Remit
SEP-31 Transaction: sep31-alpha-001
Position status: Active or Repaid
Collateral type: cTBill
Proof status: Verified
Tenor: 3 days
Public visibility: Amounts hidden
```

Hidden values:

```txt
Collateral amount: Hidden
Draw amount: Hidden
Reserve size: Hidden
LTV: Hidden
Repayment amount: Hidden
Counterparties: Hidden
```

Verification drawer rows:

```txt
CreditOpened event
DrawExecuted event
Repaid event
Verifier contract
Position nullifier
Commitments
```

Consistency rule:

```txt
Every hidden private value must use HiddenValue. Never use blank cells or "N/A".
```

## Page 7: Public Observer / Public Proof View

Primary components:

```txt
Card
Badge
Accordion
Table
Tooltip
Alert
```

Reusable components:

```txt
StatusBadge
HiddenValue
MetricCard
VerificationDrawer
```

Main sections:

```txt
Proof attestation
Policy checks
Privacy boundary
Technical verification drawer
```

Visible fields:

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

Consistency rule:

```txt
This page should look like an attestation, not a block explorer.
```

## Page 8: Auditor / Unlock

Primary components:

```txt
Card
Button
Dialog
Input
Label
Alert
Progress
Toast / Sonner
```

Reusable components:

```txt
RoleGate
ProofProgress
ActionPanel
```

Main sections:

```txt
Role switch
Credential loader
Decrypt progress
Unlock result
```

Visible fields:

```txt
Current role: Public Observer
Target role: Auditor
Credential: Demo auditor credential
Scope: Full position audit trail
```

Primary CTA:

```txt
Load demo auditor credential
Decrypt audit trail
```

Unlock progress:

```txt
Loading auditor credential
Fetching encrypted event payloads
Decrypting locally
Audit trail unlocked
```

Consistency rule:

```txt
Use Dialog for credential confirmation. Do not navigate to a separate credential form.
```

## Page 9: Auditor / Audit Trail

Primary components:

```txt
Card
Badge
Table
Tabs
Accordion
Tooltip
Scroll Area
```

Reusable components:

```txt
MetricCard
StatusBadge
Timeline
TxReceipt
VerificationDrawer
```

Main sections:

```txt
Unlocked financial summary
Audit event timeline
Repayment update panel
Verification drawer
```

Visible fields:

```txt
Collateral amount: 250,000 cTBill
Draw amount: 50,000 cUSDC
Haircut: 10%
Fee: 142 cUSDC
Repayment amount: 50,142 cUSDC
Due date: Jul 5, 2026
Closed ledger: <ledger>
Collateral lock: Released
```

Timeline:

```txt
KYB approved
ParticipantPolicy approved Alpha
Collateral proof verified
Credit line opened
Confidential cUSDC draw executed
Auditor ciphertext emitted
Repayment confirmed
Collateral lock released
```

Verification drawer rows:

```txt
Auditor ciphertext IDs
Decryption result hash
CreditOpened tx hash
DrawExecuted tx hash
OZ transfer tx hash
Repaid tx hash
```

Consistency rule:

```txt
Unlocked private metrics still use MetricCard. Do not change layout after auditor unlock; only values change from HiddenValue to real values.
```

## Page 10: Auditor / Repayment History Proof

Primary components:

```txt
Card
Badge
Button
Progress
Alert
Accordion
Table
Toast / Sonner
```

Reusable components:

```txt
ProofProgress
MetricCard
HiddenValue
StatusBadge
VerificationDrawer
TxReceipt
```

Main sections:

```txt
History proof statement
Proof progress
Hidden history fields
Verification result
Technical drawer
```

Visible fields:

```txt
Repayment history root: Updated
Proof: prove_repayment_history
Status: Verified
Statement: Alpha has at least 3 on-time repayments
Amounts: Hidden
Dates: Hidden
Counterparties: Hidden
```

Primary CTA:

```txt
Generate history proof
```

ProofProgress labels:

```txt
Collecting private repayment leaves
Generating repayment history proof
Submitting proof to verifier
Proof verified on Stellar
```

Verification drawer rows:

```txt
RepaymentHistoryRootSet tx hash
RepaymentHistoryVerified tx hash
History root
Proof nullifier
Verifier contract
```

Consistency rule:

```txt
Reuse the same ProofProgress component from collateral proof. Change labels, not structure.
```

## Page 11: Selective Disclosure

Primary components:

```txt
Card
Badge
Button
Alert
Accordion
Table
Input
Label
Dialog
Toast / Sonner
```

Reusable components:

```txt
MetricCard
StatusBadge
ActionPanel
VerificationDrawer
TxReceipt
RoleGate
```

Main sections:

```txt
Disclosure grant summary
Scoped result
Expiry/revocation status
Viewer verification
Technical drawer
```

Visible fields:

```txt
Disclosure scope: Repayment status only
Viewer: Accountant / Lender
Grant status: Active
Expiry: <ledger or readable time>
Revocation: Available
Repayment status: On-time threshold met
On-time repayments: >= 3
Position: Repaid
```

Primary CTA:

```txt
Open disclosure
```

Secondary CTA:

```txt
Revoke disclosure
```

Verification drawer rows:

```txt
DisclosureGrantCreated tx hash
Grant ID
Viewer hash
Scope hash
Bundle hash
Expiry ledger
Revoked flag
```

Consistency rule:

```txt
Never display plaintext bundle JSON from the backend. Show only scoped fields after client-side verification.
```

## Loading States

Use `Skeleton` consistently.

Patterns:

```txt
MetricCard loading: title skeleton + value skeleton + badge skeleton
Timeline loading: 4 row skeletons
Table loading: 3 row skeletons
Proof loading: Progress + current step text
Drawer loading: skeleton rows
```

Avoid:

```txt
Full-page spinner
Random loading text
Layout shifting after data arrives
```

## Empty States

Use `Alert` inside a `Card`.

Examples:

```txt
No SEP-31 transaction selected
No proof job started
No watcher events indexed yet
No disclosure grant created
```

Each empty state should have one action:

```txt
Create transaction
Start proof
Sync watcher
Create disclosure
```

## Error States

Use `Alert` for persistent errors and `Toast / Sonner` for transient action results.

Examples:

```txt
Oracle stale
Proof rejected
Participant not approved
Transaction submission failed
Disclosure expired
Auditor credential mismatch
```

Error cards should include:

```txt
Human-readable reason
Recommended next action
Technical details in collapsed drawer
```

## Tables

Use shadcn `Table` only inside drawers or audit trail sections. Do not use tables for the main operator journey.

Good table uses:

```txt
Verification details
Event receipts
Audit trail evidence
Disclosure metadata
```

Bad table uses:

```txt
Main payout summary
Main proof progress
Primary CTA area
```

## Tabs

Use `Tabs` only for role or mode switching.

Allowed tab groups:

```txt
Public Observer / Auditor
Summary / Evidence
Current position / Repayment history
```

Avoid nested tabs.

## Dialogs

Use `Dialog` only for irreversible or credential actions.

Allowed dialogs:

```txt
Load demo auditor credential
Confirm draw
Confirm repayment
Revoke disclosure
```

Do not use dialogs for normal navigation.

## Toasts

Use `Toast / Sonner` for action feedback.

Examples:

```txt
Quote generated
Proof job started
Proof verified
Credit draw confirmed
Repayment confirmed
Disclosure revoked
```

Do not use toast as the only proof of success. The page state must update.

## Icon Policy

Use one icon family only. Recommended:

```txt
@phosphor-icons/react
```

Icon roles:

```txt
ShieldCheck: verified / policy
LockKey: privacy / collateral lock
EyeSlash: hidden public values
Receipt: tx receipt
Clock: pending / due date
Warning: errors
Key: auditor credential
ArrowsClockwise: watcher / sync
```

Do not mix icon families.

## Design Tokens

Use CSS variables or Tailwind tokens consistently.

Recommended semantic tokens:

```txt
--status-success
--status-warning
--status-danger
--status-neutral
--privacy-hidden
--evidence-border
--surface-primary
--surface-raised
```

Do not hardcode random colors inside page components.

## Final Consistency Checklist

Before shipping any page:

- Does the page use the shared shell?
- Is there exactly one primary CTA?
- Are statuses rendered through `StatusBadge`?
- Are private hidden values rendered through `HiddenValue`?
- Are raw tx/proof/contract details collapsed in `VerificationDrawer`?
- Are proof states rendered through `ProofProgress`?
- Are receipts rendered through `TxReceipt`?
- Are loading, error, and empty states present?
- Does the page avoid raw JSON in the main content?
- Does the page separate SEP-31 status from Nyx product status?

