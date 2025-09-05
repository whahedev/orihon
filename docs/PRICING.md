# Pricing

Orihon is a local JavaScript map engine, not a hosted maps API. There is no per-load infrastructure cost on our side, so billing is a **yearly commercial license per legal entity** — not map views, not seats, not domains.

**No per-seat fees. No map-view limits. No runtime license checks.**

Every plan gets the same `orihon` package from npm: Core, Standard and Advanced features included. Plans differ only in commercial rights, support and contract terms.

> Founder pricing applies to the first 100 customers recorded as purchasing an eligible paid commercial license. The annual price of the originally purchased Plan is locked for the initial Term and the next three consecutive renewal Terms. If you change Plans, the then-current price of the new Plan applies. Unless the Order states otherwise, a lapse in renewal ends the Founder price lock.

## Plans

| Plan | Price | Who it is for |
| --- | --- | --- |
| **Community** | $0 | Non-commercial, education, OSS, evaluation |
| **Indie** | $149 / year | Own products · developer / micro-business up to $100k revenue |
| **Startup** | $499 / year | Own products · companies up to $1M revenue · *Most popular* |
| **Business** | $1,499 / year | Own products · companies up to $20M revenue |
| **Agency** | $799 / year | **Required** for projects built for third parties / clients |
| **Enterprise** | From $5,000 / year | Large organizations, custom terms |

**License path by work type:**

| Work | Plan |
| --- | --- |
| Your company’s own product, SaaS or internal app | Indie / Startup / Business (by revenue) or Enterprise |
| Shipping or maintaining maps **for a client / third party** | **Agency** (required) — revenue band does not substitute |

Indie / Startup / Business never cover client deliverables, even if agency revenue is under $100k.

All paid plans include: **1 legal entity**, **unlimited developers**, **unlimited applications**, **unlimited domains**, **unlimited map views**, the full Orihon feature set, and **12 months of updates**.

## Community — $0

PolyForm Noncommercial covers Community use. Free for:

- Personal projects
- Education and research
- Open-source non-commercial projects
- Qualifying non-profit projects
- Local evaluation
- Proofs of concept
- Development **before** commercial launch

You can `npm install orihon` and build a full prototype without talking to sales. A commercial license is required only before **production commercial deployment**.

## Indie — $149 / year

For freelancers, indie hackers and tiny businesses shipping **their own** products.

- Annual revenue up to **$100,000**
- Commercial use for **your own** apps, sites and SaaS only
- Not valid for client / third-party deliverables (use **Agency**)
- Unlimited developers, apps, domains and map views
- 12 months of updates
- Community support

About **$12.40 / month**.

## Startup — $499 / year

**Most popular.** The default commercial plan for growing **first-party** products.

- Annual revenue up to **$1,000,000**
- Commercial use for **your own** SaaS, internal and customer-facing apps
- Not valid for client / third-party deliverables (use **Agency**)
- Unlimited developers, apps, domains and map views
- Email support
- 12 months of updates

## Business — $1,499 / year

For organizations where library cost is small next to engineering cost — still for **your own** products.

- Annual revenue up to **$20,000,000**
- Everything in Startup for first-party use, plus:
  - Priority support
  - Invoice payment
  - Vendor documentation
  - Security notifications
  - Migration assistance
  - Private support channel
- Not valid for client / third-party deliverables (use **Agency**)

## Agency — $799 / year

**Required** whenever you build or maintain Orihon-powered software **for a third party** (client sites, white-label, agency retainers, freelance deliverables). Revenue under Indie/Startup bands does **not** replace Agency.

Agency covers **Client Work only**. It does **not** cover your own products, services or internal Commercial Production — those need a separate Indie, Startup, Business or Enterprise Plan.

- Unlimited agency developers
- Unlimited client projects and domains
- Commercial use while the agency develops and maintains the project
- Email support
- 12 months of updates

**Boundary:** A client project stays under Agency while you are contractually responsible for development or ongoing maintenance (including deploy on the client’s infrastructure). When the client takes over independent development/maintenance of Orihon functionality — or your maintenance engagement ends — the **client** needs their own first-party license.

See [License FAQ](LICENSE-FAQ.md#agency-projects).

## Enterprise — from $5,000 / year

Price is quoted, not a single public SKU.

Typically includes:

- Unlimited developers, products and deployments
- Custom licensing terms
- Procurement support
- Priority security fixes
- SLA options
- Dedicated support
- Architecture consultation
- Migration assistance
- Private Slack / Teams / Discord channel

Optional add-ons (examples):

| Add-on | Indicative |
| --- | --- |
| Priority SLA (e.g. 24h) | +$3,000 / year |
| Migration package | +$2,500 one-time |
| Custom development / onboarding / audits | Quoted separately |

Enterprise buyers are purchasing predictability and supplier responsibility, not only JavaScript.

## What we deliberately do not sell

| Model | Why not (for Orihon today) |
| --- | --- |
| Per-developer seats | Procurement friction; “who counts as a developer?” |
| Map-view tiers | No per-view cost; feels artificial for a client-side engine |
| Feature gating (clustering / WebGL / MVT behind paywalls) | Blocks evaluation of the real product |
| Runtime license keys in production | Friction without trust; licensing stays legal/commercial |
| Separate `orihon-pro` packages | One npm package; rights differ, bits do not |

Revenue band answers one question for **first-party** plans: **what is consolidated Annual Revenue** (Licensee + Affiliates under the Agreement)? Client work is a separate question: that path is always **Agency**. Agency does not replace a First-Party Plan for your own products.

## Updates, support and perpetual production rights

Annual fees buy **updates, rights to start new applications, and support** — not a kill switch for existing production.

After a Term ends without renewal:

- You **keep** perpetual production rights to run and maintain Licensed Applications that already incorporated an Orihon version obtained during the paid Term.
- You **do not** get new applications, upgrades to versions released after the Term, or support until you renew.

Recurring revenue stays with new projects, new versions, support and Enterprise services. See the [Commercial License Agreement](COMMERCIAL-LICENSE.md) §11.

## How purchase works

1. Choose a plan (or contact for Enterprise edge cases).
2. Review the [Orihon Commercial License Agreement](COMMERCIAL-LICENSE.md) (v1.0).
3. Pay (card or invoice where offered).
4. Receive an Order / license confirmation referencing the Agreement version and Plan.

There is **no** `Orihon.setLicenseKey(...)` and **no** production console nag. Compliance is contractual under the Commercial License Agreement.

**Before checkout goes live:** put Licensor legal identity, governing law and venue on each Order (see Agreement §§19 and 25), then connect payment so “Buy Startup” has a next step.

Contact for commercial licenses: use the repository issues or the copyright holder listed in [LICENSE-NOTICE.md](../LICENSE-NOTICE.md) until a dedicated sales channel is published.

## Pricing page summary

**Community** — $0 — learning, evaluation, non-commercial  
**Indie** — $149/yr — own products · ≤ $100k revenue  
**Startup** — $499/yr — own products · ≤ $1M · *Most popular*  
**Business** — $1,499/yr — own products · ≤ $20M · priority support  
**Agency** — $799/yr — **required** for client / third-party work  
**Enterprise** — from $5,000/yr — custom terms, SLA, procurement  

**Unlimited map views. Always.**

## Related

- [Commercial License Agreement](COMMERCIAL-LICENSE.md) — v1.0 legal terms for paid plans
- [License FAQ](LICENSE-FAQ.md)
- [LICENSE](../LICENSE) — PolyForm Noncommercial 1.0.0
- [LICENSE-NOTICE.md](../LICENSE-NOTICE.md)
