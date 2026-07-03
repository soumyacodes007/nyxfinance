Use a **two-browser story**:

```txt
Left browser = Anchor Operator
Right browser = Observer Portal
```

The story is:

```txt
Alpha Remit needs short-term USDC to complete a payout.
It has tokenized treasury collateral, but does not want to reveal reserves publicly.
Nyx verifies collateral privately, releases cUSDC, then lets auditor decrypt the full trail
and prove a private repayment history.
```

## Demo Setup

Left browser:
```txt
Role: Alpha Remit / Anchor Operator
Purpose: request credit, prove collateral, draw cUSDC, repay
```

Right browser:
```txt
Role: Public Observer first, Auditor second
Purpose: prove privacy boundary
```

## Step-by-Step Story

### Step 1: Anchor Has A Real Payout Need

**Left browser: Anchor Operator**

Show:
```txt
Alpha Remit
SEP-31 Transaction: sep31-alpha-001
SEP Status: pending_stellar
Payout corridor: USD → PHP
Payout amount: 50,000 cUSDC
Settlement window: 3 days
Product status: Prefunding required
KYB: Approved
```

Say:
```txt
This isn't a mock loan screen — Alpha Remit has a real SEP-31 payout transaction running through Stellar's Anchor Platform. It's sitting at pending_stellar, waiting on liquidity. Instead of keeping USDC idle in a prefunded account, Alpha wants to borrow 50,000 cUSDC for 3 days.
```

### Step 2: Anchor Shows Private Collateral

**Left browser: Collateral Vault**

Show:
```txt
Collateral: cTBill
Collateral status: Eligible
Oracle: Fresh
Haircut: 10%
Public visibility: hidden
```

Say:
```txt
Alpha has tokenized treasury collateral, but the exact reserve size is private. Competitors should not see its liquidity position.
```

### Step 3: Public Cannot See Reserves

**Right browser: Public Observer**

Show:
```txt
Anchor: Alpha Remit
Collateral type: cTBill
Amount: Hidden
Reserve size: Hidden
Credit capacity: Hidden
```

Say:
```txt
This is the public view. The network can see Alpha is using eligible collateral, but not how much it holds.
```

### Step 4: Anchor Requests Credit And Proves Sufficiency

**Left browser: Request Private Prefunding**

Show:
```txt
Requested draw: 50,000 cUSDC
Tenor: 3 days
Collateral: cTBill
Estimated fee: 142 cUSDC
Status: Eligible
```

Click `Verify Private Collateral`.

Say:
```txt
Now Alpha proves in zero knowledge that its private collateral covers the requested credit after haircut.
```

Show: `Private collateral verified`.

### Step 5: Public Still Sees Nothing Sensitive

**Right browser: Public Observer**

Show:
```txt
Proof status: Verified
Collateral amount: Hidden
Draw amount: Hidden
LTV: Hidden
```

Say:
```txt
Even after the proof verifies, the public only sees that policy was satisfied. The actual collateral and draw amount stay hidden.
```

### Step 6: Anchor Draws cUSDC

**Left browser**

Click `Draw 50,000 cUSDC`.

Show:
```txt
Credit line opened
cUSDC released
Collateral locked
Tx confirmed
```

Say:
```txt
The credit line opens, the collateral commitment is locked, and cUSDC is released privately to Alpha for the payout.
```

### Step 7: Public Sees Active Position, Not Amounts

**Right browser: Public Observer**

Show:
```txt
Position status: Active
Anchor: Alpha Remit
Collateral: cTBill
Tenor: 3 days
Amount: Hidden
Collateral size: Hidden
```

Say:
```txt
A competitor can see a position exists, but cannot infer Alpha's reserves, draw size, or stress level.
```

### Step 8: Switch Right Browser To Auditor

**Right browser**

Toggle `Public Observer → Auditor`. Click `Load Demo Auditor Credential` → `Decrypt Audit Trail`.

Show decrypting state:
```txt
Loading auditor key
Decrypting encrypted event payloads
Audit trail unlocked
```

Say:
```txt
Now we switch to the authorized auditor. Same position, different credential.
```

### Step 9: Auditor Sees Full Trail — Then Repayment Updates Live

**Right browser: Auditor View (stays open through repayment)**

Show:
```txt
Collateral amount: 250,000 cTBill
Draw amount: 50,000 cUSDC
Haircut: 10%
Fee: 142 cUSDC
Due date: Jul 5, 2026
Status: Active
```

Say:
```txt
The auditor sees the full financial trail — collateral, draw, fee, due date — decrypted locally with their own key. Nyx never exposes these values publicly, and our backend never sees them either.
```

**Left browser** — click `Repay Credit Line`.

**Right browser (same open panel, updates live):**
```txt
Status: Repaid
Repayment amount: 50,142 cUSDC
Closed ledger
Collateral lock released
```

Say:
```txt
Same auditor session, updating live — repaid, on time, lock released. One continuous audit trail.
```

### Step 10: Repayment History Proof

**Right browser: Auditor View, same panel**

Show:
```txt
Repayment history root updated
Proof: prove_repayment_history
Status: Verified — "Alpha has ≥3 on-time repayments"
Amounts: hidden. Counterparties: hidden. Dates: hidden.
```

Say:
```txt
That repayment didn't just close this position — it fed into a second, independent proof. Alpha can now prove a real repayment track record, at least three on-time repayments, without revealing a single amount, date, or counterparty from that history. This is the harder circuit — proving a property of private history, not just a single balance check.
```

## Final 20-Second Close

Say:
```txt
Nyx turns private RWA reserves into short-term prefunding power.

The anchor gets liquidity without pre-positioning idle USDC.
The public sees compliance and status, not sensitive amounts.
The auditor sees the full trail — and can verify a private repayment history, not just one transaction.
Any single fact, like on-time repayment, can be selectively shared without exposing the rest.
Every credit line is backed by real ZK collateral verification on Stellar.
```

## Browser Layout During Demo

```txt
Left: Anchor Operator
Right: Observer Portal → Auditor
```

Do not show all roles at once. The strongest moment is:
```txt
Same position.
Public cannot see amounts.
Auditor loads credential.
Amounts unlock — and history unlocks with them.
```