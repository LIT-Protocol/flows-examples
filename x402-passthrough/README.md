# x402 Passthrough Flow

Proxies x402-protected APIs, paying with the platform's crypto wallet. Callers pay this flow, and the flow pays the upstream API — acting as a payment relay.

## How it works

```
Caller → [pays this flow via x402/credits] → Flow (TEE) → [pays upstream via x402] → Upstream API
```

1. Caller sends `{ targetUrl, method?, body?, headers? }`
2. Flow makes initial request to target URL
3. If upstream returns 402, flow decodes the PAYMENT-REQUIRED header
4. Flow signs an EIP-3009 `TransferWithAuthorization` using the vault PKP wallet
5. Flow re-sends with the `PAYMENT-SIGNATURE` header
6. Returns upstream response + `_actualCost` (what the upstream actually charged)

## Dynamic pricing (upto scheme)

This flow uses the `upto` payment scheme — the caller authorizes up to a max amount, and only gets charged what the upstream actually costs. The `_actualCost` field in the response tells the platform what to settle.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetUrl` | string | yes | The x402-protected URL to call |
| `method` | string | no | HTTP method (default: GET) |
| `body` | object | no | Request body (JSON) |
| `headers` | object | no | Additional headers |

## Response Fields

| Field | Description |
|-------|-------------|
| `data` | The upstream API response |
| `upstreamStatus` | HTTP status from the upstream |
| `_actualCost` | What was paid to the upstream (6-decimal raw units) |
| `paidTo` | Address that received the upstream payment |
| `paidFrom` | Vault PKP address that sent the payment |

## Operational requirement

The vault PKP wallet needs USDC on Base to pay upstream APIs. Fund the address shown after publishing.

## Example

```bash
curl -X POST https://flows.litprotocol.com/api/flows/x402-passthrough/invoke \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "targetUrl": "https://stableenrich.dev/api/exa/search",
      "method": "POST",
      "body": { "query": "AI agents", "numResults": 3 }
    }
  }'
```
