**Core Stellar**
| Need | Link |
|---|---|
| Stellar Testnet docs | [developers.stellar.org/docs/networks](https://developers.stellar.org/docs/networks) |
| Testnet RPC | `https://soroban-testnet.stellar.org` |
| Testnet Horizon | `https://horizon-testnet.stellar.org` |
| Friendbot | `https://friendbot.stellar.org` |
| Stellar Lab | [lab.stellar.org](https://lab.stellar.org/) |
| Fund account in Lab | [lab.stellar.org/account/fund](https://lab.stellar.org/account/fund) |
| Contract Explorer | [lab.stellar.org/smart-contracts/contract-explorer](https://lab.stellar.org/smart-contracts/contract-explorer) |
| Testnet Explorer | [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet/) |
| Stellar CLI docs | [CLI docs](https://developers.stellar.org/docs/tools/cli) |
| Stellar CLI GitHub | [stellar/stellar-cli](https://github.com/stellar/stellar-cli) |
| Quickstart docs | [Quickstart docs](https://developers.stellar.org/docs/tools/quickstart) |
| Quickstart GitHub | [stellar/quickstart](https://github.com/stellar/quickstart) |

Use network passphrase:

```txt
Test SDF Network ; September 2015
```

**Anchor Platform**
| Need | Link |
|---|---|
| Anchor Platform docs | [Anchor Platform docs](https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/architecture) |
| Quick-run / Docker setup | [Getting Started](https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/getting-started) |
| Anchor Platform GitHub | [stellar/anchor-platform](https://github.com/stellar/anchor-platform) |
| Anchor Platform Docker Hub | [stellar/anchor-platform](https://hub.docker.com/r/stellar/anchor-platform) |
| Demo Wallet | [demo-wallet.stellar.org](https://demo-wallet.stellar.org/) |
| SEP-31 docs | [SEP-31 Cross-Border Payments](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md) |
| SEP-12 docs | [SEP-12 Customer Info](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md) |
| SEP-10 docs | [SEP-10 Auth](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md) |
| SEP-38 docs | [SEP-38 Quotes](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md) |

Anchor Platform testnet runs locally through Docker. Expected local URL:

```txt
http://localhost:8080/.well-known/stellar.toml
```

**OpenZeppelin Confidential Tokens**
| Need | Link |
|---|---|
| Stellar blog announcement | [Developer Preview: Confidential Tokens](https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar) |
| Confidential token source | [OZ confidential token folder](https://github.com/OpenZeppelin/stellar-contracts/tree/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential) |
| README | [README.md](https://github.com/OpenZeppelin/stellar-contracts/blob/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/README.md) |
| Compliance spec | [COMPLIANCE.md](https://github.com/OpenZeppelin/stellar-contracts/blob/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/docs/COMPLIANCE.md) |
| Design doc | [DESIGN.md](https://github.com/OpenZeppelin/stellar-contracts/blob/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/docs/DESIGN.md) |
| Storage/interface code | [storage.rs](https://github.com/OpenZeppelin/stellar-contracts/blob/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/storage.rs) |
| Noir circuit helpers | [circuits/lib](https://github.com/OpenZeppelin/stellar-contracts/tree/feat/confidential-verifier-ultrahonk/packages/tokens/src/confidential/circuits/lib) |
| Main OZ Stellar repo | [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) |

No safe assumption of reusable public `cUSDC`, `cTBill`, or `cXAUm` testnet deployments. Deploy your own wrappers.

**ZK / Noir / UltraHonk**
| Need | Link |
|---|---|
| Nethermind verifier GitHub | [NethermindEth/rs-soroban-ultrahonk](https://github.com/NethermindEth/rs-soroban-ultrahonk) |
| Noir docs | [noir-lang.org/docs](https://noir-lang.org/docs/) |
| Noir GitHub | [noir-lang/noir](https://github.com/noir-lang/noir) |
| Barretenberg docs | [barretenberg.aztec.network/docs](https://barretenberg.aztec.network/docs/) |
| Barretenberg GitHub | [AztecProtocol/aztec-packages/barretenberg](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg) |
| Noir on Stellar guide | [James Bachini: Noir on Stellar](https://jamesbachini.com/noir-on-stellar/) |

Use pinned versions from Nethermind repo:

```txt
Noir: 1.0.0-beta.9
Barretenberg: 0.87.0
```

**Reflector Oracle**
| Need | Link |
|---|---|
| Reflector docs | [reflector.network/docs](https://reflector.network/docs) |
| Reflector GitHub org | [reflector-network](https://github.com/reflector-network) |
| Reflector contract GitHub | [reflector-contract](https://github.com/reflector-network/reflector-contract) |
| Stellar oracle provider docs | [Oracle Providers](https://developers.stellar.org/docs/data/oracles/oracle-providers) |
| SEP-40 oracle standard | [SEP-40](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md) |

Reflector Testnet contracts from Stellar docs:

```txt
Stellar DEX Testnet:
CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP

External CEXs & DEXs Testnet:
CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63

Fiat FX Testnet:
CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W
```

**Blend Optional Integration**
| Need | Link |
|---|---|
| Blend docs | [docs.blend.capital](https://docs.blend.capital/) |
| Blend deployments | [Deployments](https://docs.blend.capital/mainnet-deployments) |
| Blend integration docs | [Integrations](https://docs.blend.capital/tech-docs/integrations) |
| Blend v2 contracts | [blend-contracts-v2](https://github.com/blend-capital/blend-contracts-v2) |
| Blend utils | [blend-utils](https://github.com/blend-capital/blend-utils) |
| Testnet contracts JSON | [testnet.contracts.json](https://github.com/blend-capital/blend-utils/blob/main/testnet.contracts.json) |

Useful Blend testnet IDs:

```txt
USDC:
CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU

Pool Factory V2:
CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6

Backstop V2:
CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA

Testnet V2 Pool:
CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF

Oracle Mock:
CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI
```

**Circle / CCTP Optional**
| Need | Link |
|---|---|
| Circle Faucet | [faucet.circle.com](https://faucet.circle.com/) |
| CCTP on Stellar docs | [CCTP on Stellar](https://developers.circle.com/cctp/references/stellar) |
| CCTP Stellar contracts | [Contracts and interfaces](https://developers.circle.com/cctp/references/stellar-contracts) |
| Stellar CCTP docs | [Stellar cross-chain transfers](https://developers.stellar.org/docs/tokens/cross-chain-transfers) |
| CCTP quickstart | [Transfer USDC to/from Stellar](https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc) |

CCTP Stellar Testnet contracts:

```txt
TokenMessengerMinter:
CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP

MessageTransmitter:
CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY

CctpForwarder:
CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ
```

**Wallet / Frontend**
| Need | Link |
|---|---|
| Freighter docs | [Freighter Wallet docs](https://developers.stellar.org/docs/build/guides/freighter) |
| Freighter GitHub | [stellar/freighter](https://github.com/stellar/freighter) |
| Freighter API npm | [@stellar/freighter-api](https://www.npmjs.com/package/@stellar/freighter-api) |
| Stellar Wallets Kit docs | [Stellar Wallets Kit](https://creit-tech.github.io/Stellar-Wallets-Kit/) |
| Stellar Wallets Kit GitHub | [Creit-Tech/Stellar-Wallets-Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit) |
| JS Stellar SDK docs | [stellar.github.io/js-stellar-sdk](https://stellar.github.io/js-stellar-sdk/) |
| JS Stellar SDK GitHub | [stellar/js-stellar-sdk](https://github.com/stellar/js-stellar-sdk) |

**SDEX / Path Payments Optional**
| Need | Link |
|---|---|
| Liquidity/SDEX docs | [Liquidity on Stellar](https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools) |
| Path payments docs | [Path Payments](https://developers.stellar.org/docs/build/guides/transactions/path-payments) |
| Strict receive paths API | [Horizon paths/strict-receive](https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-strict-receive-payment-paths) |
| Horizon GitHub | [stellar/stellar-horizon](https://github.com/stellar/stellar-horizon) |

For your MVP, the must-use stack is: **Stellar Testnet + Anchor Platform + OZ Confidential Token + Nethermind UltraHonk + Reflector/demo oracle + Freighter/SDK**. Blend and CCTP are optional integrations, not required for the first polished demo.