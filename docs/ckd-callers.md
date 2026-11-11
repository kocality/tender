# CKD callers of v1.signer

Read on 2026-11-10 before 08:23 UTC, before Tender's own mainnet CKD requests. Method: NearBlocks v3 receipts of `v1.signer` filtered by `request_app_private_key`; each caller's latest request has its `app_public_key` decoded from archival RPC (`EXPERIMENTAL_receipt`). Class `public-identity` / `public-generator` means the request used an app public key that is public (the identity or generator key of a public-key mode); `private` means any other app key.

Total: 268 receipts from 18 callers. Callers using a public app key (excluding Tender's own accounts): 0. Latest receipts that could not be read from archival RPC: 0.

| Caller | Requests | Latest receipt | App key class |
|---|---|---|---|
| `ckd-auth.logunov.near` | 65 | `HjcyuuRpShixKDUh9TiXxMdbRp3CDUJg71TDgBJ1rquY` | private |
| `dao.outlayer.near` | 41 | `FqSMRDJXUKRMaYJpdJVT58GyW3GtN99i7PiGt4DmDkJo` | private |
| `defuse-ops.near` | 34 | `GAcYp1EcMTcf1S6iuh5MDqhCmTkEZwrtzwoFb5XHEHxb` | private |
| `outlayer-admin.defuse-ops.near` | 33 | `4tg1JvMtBbMXrwJtLXMbFp9yew7GM3E2pbdEaGp73UUw` | private |
| `vault.agentsmarket.near` | 26 | `HWdocGD6jEH9CgbQ1YDSbtFjucrDPLz6tJHdy1Z8PCo` | private |
| `treasure-awaits.near` | 21 | `FzjtEprJhDSZGEJuziSD5tPQbYvt5PqbQ3CGoj8KBNKb` | private |
| `annon-dev.payaion.near` | 14 | `2UbxZUHqkVLX7U6peBJwF7HWqjfPt2YbeTs9LGyH9Ns7` | private |
| `outlayer-admin.near` | 12 | `Df69phMBNvVrn8iAwQmVF7pnTTasyfMiGzgiuzoV2QG5` | private |
| `vault.deposit.tipbot.near` | 5 | `A3zkDko24erUJvQJAJ92VeSVNpLfq8QYsbrsxzLEpnzX` | private |
| `iamgrut.near` | 5 | `CSte4VB9GZUQzMnG3UbSADiZpSo8HdQHB9gTfk1C2Cxs` | private |
| `annon-dev2.payaion.near` | 2 | `53X5bPNdK9kLwyaS1T6dc9M8yeLBEvFAZU8aYA5Q3NdX` | private |
| `5927d994c15aec1a3dbdacc4d8b60223f41926f02ec0cc88e5b8fe405f781b2b` | 2 | `BJCnfTxhXo5J34o1xM1YbEzPi9XJYVHFJyXCUAqRCJfn` | private |
| `654c97ea12108c7ba7e804751df6ae7b7a0382ed8a1eda91142fccb0e8fc9a78` | 2 | `AoXnkSKbPa4TYFzY3RmsLDgdpFyt2fVgsrYANFVxQk1G` | private |
| `youtick.near` | 2 | `E7NMEBVVw4Qi91WUKsJjSxb1Nnbb2qw1jTe5md824ZCd` | private |
| `121cdf624ff04dba5848cd055075549a4574eed7ede06e4fa9ce430cfec5f859` | 1 | `ummmcAc68rcEwmjtMix48ZXrieR4jD7GmK1gHbmoDtD` | private |
| `logunov.near` | 1 | `4SYkis8JTS22NjMGqexPhy7sKwWbZeZFBuNyUZkaTVrA` | private |
| `testws1.near` | 1 | `565poZ7MdZny3xncBpQaQppUpsJZZPeHXoYp8bER75Gr` | private |
| `substance-test-1.near` | 1 | `7BWQGpGmBDxCuxBb4uMseJHtGmixgZuA5zgVKJEwJsF` | private |

## Tender's own accounts

`tenderseal.near`, `spike.tenderseal.near`, `rehearsal.tenderseal.near`, the planned `v1.tenderseal.near` and the implicit spike account `0a92bc62601112332a225ea19961d549bb4b689bbd723f5dcf1f19bab5212620`: none appears among the callers above. All our recorded requests used a public app key ([JUDGES › Mainnet spikes](../JUDGES.md#mainnet-spikes-before-the-contract)).
