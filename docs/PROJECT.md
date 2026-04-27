# Federated Reserve

> A peer-to-peer mesh of sovereign AI state-treasurers running on real public data, with real capital onchain, auditable against the actual decisions of human policymakers.

---

## TL;DR

50 AI agents, one per US state, plus a Federal Reserve agent and a Treasury agent. Each is a sovereign node running its own AXL peer. They ingest real public economic data (FRED, BLS, BEA, MSRB, NOAA, GDELT), reason over their state's economic position, and negotiate bilateral and multilateral capital flows directly with each other — no central coordinator, no broker. Decisions settle as real swaps on Unichain via the Uniswap Trading API. Memory and learned strategy persist to 0G Storage. Each headline state-agent is minted as an ERC-7857 iNFT — a transferable, ownable AI policymaker.

The goal is not just simulation. It is a falsifiable empirical question: **given the same public information, can a network of AI agents allocate capital and coordinate fiscal response better than the humans currently doing it?**

---

## The Thesis

Every dollar a US state government manages is governed by public information. Tax revenue, spending categories, rainy-day fund balances, pension fund composition, bond issuances, and intergovernmental transfers are all reported. The Fed's rate decisions, the Treasury's debt issuance schedule, FEMA's disaster declarations, BLS unemployment by state — public. The data exists. The decisions exist.

What does *not* exist is a way to ask: **what would have happened if the decisions were made differently, in real time, with the same information?**

Federated Reserve is that ask, run as a live system. State-agents make capital allocation decisions every simulated quarter (one real hour). They negotiate inter-state aid, hedge risk, issue bonds, and respond to shocks. Every decision is logged, with reasoning, against the historical baseline of what the actual policymaker did at the equivalent moment.

The pitch to a mayor's office, a state treasurer, or a sovereign-wealth fund is not "replace the humans." It is "here is a co-pilot that has been running on public data for 30 days, here is its track record vs reality, here is where it disagreed and why."

---

## Why This Wins as a Hackathon Submission

The project is architected to win three tracks simultaneously, with the same code, because each protocol is load-bearing for a different layer of the system.

**AXL (primary, $5,000 pool)** — The federation-of-states metaphor IS peer-to-peer. States are sovereign entities that negotiate without a central broker. Massachusetts and California negotiating a bilateral swap should not route through a server, and in this system it does not. Each state-agent is a separate AXL node. The "no central coordinator" qualification is satisfied not as a constraint we worked around, but as the literal thesis.

**Uniswap ($5,000 pool)** — Capital management is the thesis. Without real swaps, the agents are just LLMs talking. The Uniswap Trading API turns every economic decision into a real onchain transaction. State-agents act as treasuries (rebalancing reserves), as bond issuers (auctioning debt), and as liquidity providers (earning fees in inter-state pools). This is "agentic finance with novel primitives" — exactly what the track copy asks for.

**0G ($7,500 pool, up to 5 winners)** — Each headline state-agent is an iNFT. Its strategy, memory, and reasoning history are encrypted on 0G Storage, with the ERC-7857 token on 0G Chain representing ownership. The "transferable AI policymaker" angle is genuinely novel — at the end of the demo, the Massachusetts iNFT can be transferred to a real wallet, and the recipient owns a fully-functioning shadow MA treasurer with its complete decision history intact.

---

## What Each Agent Does

Each state-agent runs an autonomous loop:

1. **Ingest** the latest snapshot of its state's economic indicators (unemployment, GDP growth, tax revenue projections, debt service costs, news sentiment) from a shared data plane
2. **Reason** about its position — is it stressed, healthy, accumulating, or defending? — using Claude API
3. **Broadcast** its updated economic posture to the AXL mesh via GossipSub
4. **Negotiate** bilaterally over A2A with peer states (swap proposals, bond auctions, emergency aid requests) and multilaterally for coalition responses
5. **Execute** the resulting capital flows as real swaps on Unichain via the Uniswap Trading API
6. **Persist** the decision, its inputs, the reasoning trace, and the outcome to 0G Storage (KV for current state, Log for history)
7. **Reflect** at end of each simulated quarter — what did I predict, what happened, update strategy weights

The Federal Reserve agent runs a parallel loop at a higher level — sets the base rate informing everyone's borrowing costs, monitors aggregate inflation/employment across the mesh, and can issue federal debt or coordinate stimulus during shocks. The Treasury agent manages federal-to-state transfers.

---

## The Financial Primitives

Organized in tiers by load-bearing-ness for the demo.

### Tier 1 — Core (must-ship)

- **Treasury reserves.** Each state holds a portfolio: USDC reserve (cash equivalent), tokenized treasury exposure (safe yield), tokenized equity exposure (productive risk). Mirrors actual state investment pool composition.
- **Rainy-day fund mechanics.** Each state must maintain a reserve ratio (10% of notional annual budget). Falling below triggers defensive rebalancing. Real states do this; agents must too.
- **Revenue ingestion.** Each tick (one simulated quarter), agents receive scaled tax revenue calibrated to real state GDP and tax-collection data.
- **Expenditure obligations.** Fixed costs drawn each tick (education, Medicaid match, payroll). Non-negotiable. Creates real cash flow pressure.
- **Inter-state swaps.** When states want to rebalance, real Uniswap swaps on Unichain. This is where Uniswap integration lives.

### Tier 2 — Debt and credit

- **Municipal bond issuance.** A state under stress can issue debt — mints bond tokens with coupon and maturity. Other states bid via AXL A2A flows. Interest rates emerge from supply/demand.
- **Algorithmic credit ratings.** A meta-agent scores creditworthiness from debt-to-revenue, reserve ratio, recent performance. Affects borrowing costs. Translates real Moody's/S&P methodology into prompts.
- **Bilateral inter-state lending.** Rich states extend credit to stressed states, terms negotiated peer-to-peer over AXL. This does NOT exist in real US federalism — agents can design mechanisms humans can't, which is the point.

### Tier 3 — Monetary/fiscal coordination

- **Federal Reserve agent.** Sets the federal funds rate each tick based on aggregate inflation/unemployment. State borrowing costs are spreads over the Fed rate.
- **Treasury agent.** Manages federal transfers, issues federal debt, coordinates response to shocks.
- **Programmatic stimulus.** During a shock, state agents can coordinate joint stimulus in minutes over AXL. The mayor pitch lands here: "regional response without political bottleneck."

### Tier 4 — Productive capital (stretch, ship if Day 6 has time)

- **Pension-style sub-portfolios.** Long-horizon allocations with different risk tolerance. Performance scored against simulated benchmarks.
- **Infrastructure project financing.** Agents propose projects ("MA wants to fund $500M transit"), other agents co-invest via revenue bonds. This is the Boston-pitch primitive — literally how the MBTA gets financed.
- **Catastrophe insurance mesh.** States pool capital against disaster risk. NOAA event triggers parametric payouts. FL/LA/TX exposed to hurricanes pre-purchase coverage from inland states.

### Tier 5 — Things humans cannot do (the differentiator)

- **Continuous rebalancing.** Real pension funds rebalance quarterly or annually. Agents do it every tick.
- **Cross-state hedging.** MA and CA both have tech-correlated tax revenue. They can hedge each other via AXL-negotiated swap contracts.
- **Prediction-market signal aggregation** (stretch). Agents post markets on policy outcomes; market price feeds back into allocation.

### Scope discipline

- Build **8-10 deep state agents** (MA, CA, TX, NY, FL, IL, WA, AK as resource-state outlier). The other 40 are "observer" agents — they participate in the mesh and respond to broadcasts but have shallow policy logic. Judges and mayors care about 5-10 well-modeled states more than 50 cardboard cutouts.
- **Boston gets a sub-agent under MA.** Mirrors real intergovernmental structure. Real MA + real Boston data = the demo slide that makes Wu's office lean in.

---

## Data Sources

All free, all public, all API-accessible. No paid feeds, no scraping, no hand-curated data. The thesis demands public data only.

### Economic indicators

- **FRED (St. Louis Fed) API.** State-level unemployment, labor force participation, personal income, housing, GDP. Free key, generous rate limits, TypeScript clients exist. This is the backbone.
- **BLS API.** Bureau of Labor Statistics, state and metro employment, CPI, wages, JOLTS.
- **BEA API.** State GDP, regional accounts, personal income.
- **Census Bureau API.** Demographics, ACS, business formation, Annual Survey of State Government Finances (real state budget data).

### Fiscal data

- **MSRB EMMA.** Municipal bond disclosures, real issuance data, real yields. Gold for the bond primitive.
- **NASBO.** State budget reports, fiscal surveys.
- **Pew Fiscal 50.** State fiscal health indicators, comparable across states.
- **State treasurer/comptroller sites.** MA Treasury publishes monthly investment pool reports — real data we mirror for the MA agent.

### Markets

- **Uniswap subgraph + Trading API.** Onchain pool state, quotes, swaps.
- **FRED.** Treasury yield curves.
- **Polygon.io / Yahoo Finance.** Equity references for tokenized equity exposure.

### News and events

- **GDELT Project.** Geocoded news events, free, massive. Query "events in Massachusetts in the last hour." Best news-to-state pipeline.
- **Federal Register API.** New federal regulations, executive orders.
- **OpenStates.org.** Aggregated 50-state legislature APIs.
- **NOAA Storm Events Database.** Hurricanes, floods, tornadoes by state and date — feeds catastrophe primitive.
- **EIA.** Energy prices, state production. Oil shock → TX/ND/AK direct exposure.

---

## The Demo

The demo is the project. If the demo doesn't land, nothing else matters.

### Layout (worldmonitor-inspired)

- **Center:** deck.gl US map. States colored by treasury health (green/amber/red). Capital flow arcs animate between states on swap execution. Click a state to focus it.
- **Left rail:** live AXL message feed scrolling top-to-bottom. Color-coded by message type — proposals (blue), executions (green), negotiations (amber), broadcasts (white). This is the visual proof of peer-to-peer.
- **Right rail:** news ingestion stream (state-tagged), and the "agent vs actual" scorecard updating live.
- **Bottom panel:** treasury composition for the focused state, swap execution log with Unichain tx hashes, latest reflection summary.
- **Top bar:** simulation clock, total mesh TVL, swaps/hour, mesh message volume.

### The 90-second judging walkthrough

1. **Open with the map.** "50 state-agents, peer-to-peer over AXL, real capital on Unichain. Watch the mesh." Capital flows pulse in real time. Message feed scrolls.
2. **Click Massachusetts.** Show the MA agent's portfolio, last decision, reasoning trace from 0G Storage. Show the Boston sub-agent under it.
3. **Inject a shock.** Click a button. "Hurricane makes landfall in Florida." NOAA event injects into the mesh. FL's catastrophe insurance triggers. Inland states activate aid pool. Coordinated response over AXL in real time. Show messages flowing.
4. **Show the comparison.** Pull up the historical replay panel. "We replayed Q1 2020. Here's what the MA agent did. Here's what the actual MA Treasury did. Delta: agent maintained reserve ratio, real state breached. Agent issued bonds 6 weeks earlier, locked lower rate."
5. **Show the iNFT.** "This MA agent is an iNFT. Here's the contract on 0G explorer. Here's the encrypted memory pointer to 0G Storage. The agent is transferable — you can own this policymaker."
6. **Kill a node.** Demonstrate resilience. "Watch the mesh route around it." Score on AXL depth.

### The shock library (preload)

- Hurricane in Florida (NOAA replay)
- Tech sector layoffs cascading (BLS replay of 2022 Q4)
- Oil shock (EIA energy spike)
- Federal rate hike surprise
- Bank stress (regional bank distress signal)

---

## Pitch Audiences (Beyond the Hackathon)

- **Mayor Wu's office (Boston).** Show the Boston sub-agent. Frame as: "regional fiscal coordination without political bottleneck, running on data your treasurer already publishes."
- **State treasurer offices.** Frame as audit/sanity-check tool — what would an algorithmic peer have done?
- **Sovereign wealth research.** The cross-state hedging primitive is novel and presentable to academic finance.
- **0G / Gensyn Foundation.** The Foundation grant pipeline mentioned in the AXL prize is real. Plan an application post-hackathon if results warrant.

---

## Non-Goals

To preserve the integrity of the project, things we explicitly do NOT build:

- A trading bot. This is not "Claude plays the stock market."
- Real-money execution outside of testnet. Unichain testnet only. The audit/comparison story does not require real money to be persuasive.
- Simulation of the political process. We model policy *decisions*, not voting, lobbying, or public opinion. That is a much harder problem and would dilute the thesis.
- Synthetic data fallbacks. If a public data source is down, agents pause or use last-known values. Never fake data — it would invalidate the comparison-to-reality story.
- A "winner" framing. We don't claim agents beat humans. We claim agents make different decisions, observably, with the same information, and we let the comparison speak for itself.

---

## Risk Register

Honest about what could go wrong.

- **AXL maturity.** New infrastructure. Day 0 spike is the gate.
- **Uniswap testnet liquidity.** Unichain testnet pools may be thin. Mitigation: seed our own pools for the simulated state-token exposure if needed.
- **0G testnet stability.** iNFT minting depends on 0G Chain being responsive. Mitigation: keep iNFT path optional — fall back to Storage-only if 0G Chain is flaky.
- **Data source rate limits.** FRED/BLS have generous limits but BLS in particular caps at 500 queries/day unregistered. Solution: registered API key, single ingestion service that fans out to all agents.
- **Frontend complexity.** worldmonitor-style UI is ambitious. Mitigation: start with a working ugly version on Day 5, polish on Day 6.
- **LLM cost.** 50 agents calling Claude API every tick gets expensive fast. Mitigation: 8-10 deep agents on Claude, 40 observer agents on a cheaper model or rule-based logic. Tick interval set generously (1 hour real-time = 1 quarter simulated).

---

## What Success Looks Like

By demo day:

- Mesh of 10+ separate AXL nodes (4-6 on real VMs, rest containerized) sustaining for 24+ hours
- 100+ real swaps executed on Unichain testnet
- 6+ state iNFTs minted on 0G testnet, each with non-trivial decision history on 0G Storage
- One complete replay of a historical quarter (Q1 2020 or Q3 2008) with side-by-side vs reality
- Live demo URL, public GitHub, three submissions filed (AXL, Uniswap, 0G), FEEDBACK.md drafted
- Demo video under 3 minutes, optimized for the AXL "depth of integration" criterion
