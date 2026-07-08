confidential-prefunding/
├─ README.md
├─ .env.example
├─ docker-compose.yml
├─ package.json
├─ pnpm-workspace.yaml
├─ deployments/
│  ├─ localnet.json
│  ├─ testnet.json
│  └─ README.md
│
├─ contracts/
│  ├─ Cargo.toml
│  ├─ Makefile
│  ├─ scripts/
│  │  ├─ deploy_localnet.ps1
│  │  ├─ deploy_testnet.ps1
│  │  ├─ init_confidential_tokens.ps1
│  │  └─ seed_demo_state.ps1
│  ├─ contracts/
│  │  ├─ participant-policy/
│  │  ├─ collateral-policy-registry/
│  │  ├─ collateral-lock-registry/
│  │  ├─ prefunding-credit-line/
│  │  ├─ repayment-history-registry/
│  │  ├─ disclosure-registry/
│  │  ├─ oracle-adapter/
│  │  ├─ prefunding-compliance-hooks/
│  │  ├─ collateral-sufficiency-verifier/
│  │  ├─ repayment-history-verifier/
│  │  └─ mock-assets/
│  └─ tests/
│     ├─ participant_policy.rs
│     ├─ collateral_lock.rs
│     ├─ prefunding_credit_line.rs
│     ├─ disclosure_registry.rs
│     └─ integration_credit_flow.rs
│
├─ circuits/
│  ├─ README.md
│  ├─ shared/
│  │  ├─ oz_commitment.nr
│  │  ├─ range.nr
│  │  ├─ merkle.nr
│  │  └─ types.nr
│  ├─ collateral_sufficiency/
│  │  ├─ Nargo.toml
│  │  ├─ src/
│  │  │  └─ main.nr
│  │  ├─ Prover.example.toml
│  │  ├─ test_vectors/
│  │  │  ├─ valid.json
│  │  │  ├─ insufficient_collateral.json
│  │  │  ├─ wrong_randomness.json
│  │  │  └─ replay_nullifier.json
│  │  └─ artifacts/
│  │     ├─ collateral_sufficiency.json
│  │     ├─ vk
│  │     └─ README.md
│  └─ repayment_history/
│     ├─ Nargo.toml
│     ├─ src/
│     │  └─ main.nr
│     ├─ Prover.example.toml
│     ├─ test_vectors/
│     │  ├─ valid_3_on_time.json
│     │  ├─ late_repayment.json
│     │  ├─ duplicate_leaf.json
│     │  └─ insufficient_history.json
│     └─ artifacts/
│        ├─ repayment_history.json
│        ├─ vk
│        └─ README.md
│
├─ backend/
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ Dockerfile.api
│  ├─ Dockerfile.prover
│  ├─ src/
│  │  ├─ index.ts
│  │  ├─ config/
│  │  │  ├─ env.ts
│  │  │  └─ contracts.ts
│  │  ├─ db/
│  │  │  ├─ schema.sql
│  │  │  ├─ sqlite.ts
│  │  │  └─ migrations/
│  │  ├─ routes/
│  │  │  ├─ health.ts
│  │  │  ├─ demo-state.ts
│  │  │  ├─ prefunding.ts
│  │  │  ├─ proof.ts
│  │  │  ├─ disclosure.ts
│  │  │  ├─ auditor.ts
│  │  │  └─ watcher.ts
│  │  ├─ services/
│  │  │  ├─ stellar-rpc.ts
│  │  │  ├─ horizon.ts
│  │  │  ├─ contract-client.ts
│  │  │  ├─ quote-engine.ts
│  │  │  ├─ proof-job-service.ts
│  │  │  ├─ disclosure-service.ts
│  │  │  ├─ auditor-payload-service.ts
│  │  │  ├─ watcher.ts
│  │  │  └─ snapshot-cache.ts
│  │  ├─ prover/
│  │  │  ├─ run-nargo.ts
│  │  │  ├─ run-bb.ts
│  │  │  ├─ collateral-witness.ts
│  │  │  └─ repayment-witness.ts
│  │  └─ types/
│  │     ├─ api.ts
│  │     ├─ contracts.ts
│  │     ├─ proof.ts
│  │     └─ demo-state.ts
│  │
│  ├─ anchor-business-server/
│  │  ├─ package.json
│  │  ├─ Dockerfile
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ customer-status.ts
│  │     ├─ sep31-transaction.ts
│  │     ├─ quote-callback.ts
│  │     ├─ participant-policy-sync.ts
│  │     └─ reconciliation.ts
│  │
│  └─ tests/
│     ├─ api.health.test.ts
│     ├─ quote.test.ts
│     ├─ proof-job.test.ts
│     ├─ watcher.test.ts
│     ├─ disclosure.test.ts
│     └─ anchor-sync.test.ts
│
├─ frontend/
│  ├─ package.json
│  ├─ next.config.ts
│  ├─ tsconfig.json
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx
│  │  ├─ anchor/
│  │  │  └─ page.tsx
│  │  ├─ vault/
│  │  │  └─ page.tsx
│  │  ├─ credit/
│  │  │  └─ page.tsx
│  │  ├─ observer/
│  │  │  └─ page.tsx
│  │  ├─ repayment/
│  │  │  └─ page.tsx
│  │  └─ system/
│  │     └─ page.tsx
│  ├─ components/
│  │  ├─ role-switcher.tsx
│  │  ├─ tx-hash.tsx
│  │  ├─ visibility-badge.tsx
│  │  ├─ proof-status.tsx
│  │  ├─ public-private-comparison.tsx
│  │  ├─ auditor-decrypt-panel.tsx
│  │  └─ disclosure-link-card.tsx
│  ├─ lib/
│  │  ├─ api.ts
│  │  ├─ stellar.ts
│  │  ├─ freighter.ts
│  │  ├─ auditor-decrypt.ts
│  │  ├─ demo-state.ts
│  │  └─ formatting.ts
│  └─ public/
│     ├─ diagrams/
│     └─ logos/
│
├─ infra/
│  ├─ anchor-platform/
│  │  ├─ config/
│  │  ├─ secrets.example.env
│  │  └─ README.md
│  ├─ docker/
│  │  ├─ api.Dockerfile
│  │  ├─ prover.Dockerfile
│  │  ├─ frontend.Dockerfile
│  │  └─ anchor-business-server.Dockerfile
│  └─ scripts/
│     ├─ start.ps1
│     ├─ stop.ps1
│     ├─ reset_demo.ps1
│     ├─ seed_accounts.ps1
│     ├─ fund_testnet_accounts.ps1
│     └─ run_e2e.ps1
│
└─ docs/
   ├─ architecture.md
   ├─ demo-script.md
   ├─ compliance-model.md
   ├─ api-spec.md
   ├─ contract-spec.md
   ├─ circuit-spec.md
   ├─ deployment-guide.md
   └─ testing-plan.md