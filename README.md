# Flows Examples

Example flows for [Flows by Lit Protocol](https://flows.litprotocol.com) — the publish-and-pay platform for code that runs in a Trusted Execution Environment (TEE).

Publish a JavaScript function, set a price, and agents pay per request via [x402](https://x402.org), credits, or card. No servers to manage, no infra to maintain.

## Examples

| Flow | Description | Secrets | Price |
|------|-------------|---------|-------|
| [oracle.js](oracle.js) | Fetch a URL and sign the response with the flow's vault PKP | None | 5c |
| [model-council.js](model-council.js) | Query 4 LLMs in parallel via OpenRouter, synthesize consensus | `OPENROUTER_API_KEY` | 90c |
| [embeddings.js](embeddings.js) | Generate OpenAI text embeddings from text or PDF | `OPENAI_API_KEY` | 2c |
| [pdf-extract.js](pdf-extract.js) | Extract text from a PDF using opendataloader-pdf | None | 2c |
| [lob-postcard.js](lob-postcard.js) | Send a physical postcard via the Lob mail API | `LOB_SECRET_API_KEY` | $1.00 |
| [non-us-proxy.js](non-us-proxy.js) | Get a non-US (Mexico) proxy from a managed pool | `WEBSHARE_API_KEY` | 2c |
| [gmail-read.js](gmail-read.js) | List recent emails (requires Gmail OAuth connection) | None (OAuth) | 2c |
| [gmail-reply.js](gmail-reply.js) | Send email replies (requires Gmail OAuth connection) | None (OAuth) | 2c |
| [github-bounty.js](github-bounty.js) | Escrow arbiter — Claude agent reviews PRs against issues, signs on-chain release | `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `MANAGED_AGENT_ID`, `MANAGED_ENV_ID` | 5c |

> **On-chain:** The [EscrowBounty](contracts/EscrowBounty.sol) contract is deployed on Base at [`0x926470ef334b72c6eBDF540a434316e87a7Aa562`](https://basescan.org/address/0x926470ef334b72c6eBDF540a434316e87a7Aa562). Anyone can create bounties — the `github-bounty` flow's vault PKP acts as the arbiter.

## Getting Started

### Install the CLI

```bash
npm i -g @lit-protocol/flows
flows login
```

### Publish a flow

```bash
# Simple flow — no secrets
flows publish oracle.js --name "My Oracle" --price 5

# Flow with a secret
flows publish embeddings.js --name "Embeddings" --price 2
flows secrets set embeddings OPENAI_API_KEY "sk-..."

# Flow with OAuth
flows publish gmail-read.js --name "Gmail Reader" --price 2 --connections gmail
```

### Invoke a flow

```bash
# As a consumer
flows invoke embeddings --params '{"input": ["What is Lit Protocol?"]}'

# PDF mode
flows invoke embeddings --params '{"pdf_base64": "'$(base64 -i doc.pdf)'"}'
```

### Use via API

```bash
curl -X POST https://flows.litprotocol.com/api/flows/embeddings/invoke \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"params": {"input": ["What is Lit Protocol?"]}}'
```

Every flow is also an MCP server at `https://flows.litprotocol.com/mcp/<slug>` — add it to Claude, Cursor, or any MCP-compatible agent.

## How Flows Work

1. **You write JavaScript.** Your code runs inside `async function main(params) { ... }` in Lit Protocol's TEE.
2. **Secrets stay secret.** API keys are encrypted and only decrypted inside the TEE. Consumers never see them — they just pay and get results.
3. **Every flow gets a vault.** A programmable key pair (PKP) tied to your flow, useful for signing data or on-chain actions.
4. **Consumers pay per request.** Via x402 (USDC on Base), platform credits (Stripe), or card (Machine Payments Protocol). No accounts or API keys needed for x402.
5. **Code is verifiable.** The source is hashed to an IPFS CID at publish time. The TEE verifies the CID before execution — nobody can swap your code.

## PDF Extraction Service

The `embeddings.js` and `pdf-extract.js` flows use a lightweight microservice at [`services/pdf-extract/`](services/pdf-extract/) for PDF text extraction. It wraps [opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf) (a Java-based PDF extraction engine) in a thin Express server deployed to Fly.io.

The service scales to zero when idle — no cost when not in use.

## Documentation

- [Full docs](https://flows.litprotocol.com/docs)
- [CLI reference](https://flows.litprotocol.com/docs?tab=cli)
- [API reference](https://flows.litprotocol.com/docs?tab=api)
- [Publishing guide](https://flows.litprotocol.com/docs?tab=publishing)
- [Secrets & encryption](https://flows.litprotocol.com/docs?tab=secrets)

## License

MIT

---

*This repo is auto-synced from the main Flows repository. To contribute, open an issue or PR here.*
