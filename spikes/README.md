# spikes/

Phase 0 dependency spikes. Each subdir proves one external dependency works
end-to-end before we commit to it in `packages/`.

Per [docs/TECHNICAL.md](../docs/TECHNICAL.md) Phase 0 — gate is "AXL works at
all"; if [00-axl-nodes](./00-axl-nodes) or [01-axl-mcp](./01-axl-mcp) fail,
escalate (Gensyn Discord) before burning Phase 1 time.

## Spike index

| # | Dir | Proves |
|---|-----|--------|
| 00 | [00-axl-nodes](./00-axl-nodes) | Two AXL nodes peer over local TLS, `/topology` agrees, `/send` + `/recv` round-trips |
| 01 | [01-axl-mcp](./01-axl-mcp) | TS `@modelcontextprotocol/sdk` server registers with Python MCP Router; remote peer calls `tools/list` and `tools/call` over AXL |
| 02 | [02-axl-a2a](./02-axl-a2a) | Bundled Python A2A server auto-derives skills from MCP services; `POST /a2a/{peer_id}` round-trips |
| 03 | [03-uniswap-quote](./03-uniswap-quote) | Uniswap Trading API `/v1/quote` returns a valid quote on Unichain Sepolia for a USDC swap |
| 04 | [04-fred-series](./04-fred-series) | FRED API returns MA unemployment series (FRED ID `MAUR`) |
| 05 | [05-0g-erc721](./05-0g-erc721) | Hello-world ERC-721 deploys on 0G Chain testnet, address visible on explorer |
| 06 | [06-unichain-erc20](./06-unichain-erc20) | Hello-world ERC-20 deploys on Unichain Sepolia, address visible on explorer |

## Prerequisites (verified during Phase 0)

- Bun ≥ 1.3 (for TS spikes)
- Go ≥ 1.25.5 — pinned automatically via `GOTOOLCHAIN=go1.25.5` in [vendor/axl/Makefile](../vendor/axl/Makefile)
- Foundry (`forge`, `cast`)
- Python 3.9+ with the `vendor/axl/integrations` package installed in `.venv`
- Homebrew OpenSSL 3.x (LibreSSL lacks ed25519)
- A funded testnet wallet on each chain (0G testnet, Unichain Sepolia) — see [.env.local](../.env.local)

## Conventions

- Each spike is self-contained in its directory.
- Each has a `README.md` documenting the proof, the run command, and the expected output.
- Bun-based spikes pull deps from `spikes/01-axl-mcp/package.json` etc., not a root workspace (workspace setup is Phase 1).
- Foundry-based spikes have their own minimal `foundry.toml`.
