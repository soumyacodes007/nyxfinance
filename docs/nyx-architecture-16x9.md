# Nyx Architecture Slide

Use this for a 16:9 pitch slide. Keep the slide title short:

```txt
Private Settlement Credit for Stellar Anchors
```

## Mermaid Diagram

```mermaid
flowchart LR
    A["Anchor / Payment Company<br/><b>Needs payout liquidity now</b><br/>Settlement capital arrives later"]
    B["Private RWA Collateral<br/><b>cTBill reserve</b><br/>Amount stays hidden"]
    C["Nyx Credit Layer<br/><b>ZK collateral check</b><br/>Policy + compliance + lock"]
    D["Liquidity Source<br/><b>Blend / Facility USDC</b><br/>Wholesale funding"]
    E["Confidential Draw<br/><b>cUSDC released</b><br/>Anchor completes payout rails"]
    F["Repayment<br/><b>Credit closes</b><br/>Collateral unlocks"]

    R["Reflector Oracle<br/>fresh price"]
    P["Public Observer<br/><b>Sees:</b> verified, active, repaid<br/><b>Does not see:</b> amounts"]
    U["Auditor<br/><b>With permission:</b><br/>decrypts full trail"]
    H["Private Repayment History<br/>proves good borrower behavior<br/>without exposing the book"]

    A --> B
    B --> C
    R --> C
    D --> C
    C --> E
    E --> F
    F --> H

    C -. public status .-> P
    E -. encrypted payloads .-> U
    F -. encrypted payloads .-> U
    H -. proof only .-> P

    classDef core fill:#0f172a,stroke:#38bdf8,color:#ffffff,stroke-width:2px;
    classDef private fill:#3b1d0f,stroke:#fb923c,color:#ffffff,stroke-width:2px;
    classDef infra fill:#102a1c,stroke:#22c55e,color:#ffffff,stroke-width:2px;
    classDef viewer fill:#26143a,stroke:#c084fc,color:#ffffff,stroke-width:2px;

    class A,C,E,F core;
    class B,H private;
    class D,R infra;
    class P,U viewer;
```

## One-Line Caption

```txt
Nyx lets anchors borrow short-term stablecoin liquidity against private tokenized collateral: the chain verifies safety, the public sees status, and auditors can decrypt only with permission.
```

## Speaker Notes

```txt
Anchors do not always lack money; they lack liquid settlement capital in the right place at the right time.
Nyx lets them use tokenized RWA collateral without exposing reserves or borrowing size.
ZK proves the collateral is enough, Reflector prices it, Blend or a facility supplies liquidity, and Confidential Tokens keep draw and repayment amounts private.
```

