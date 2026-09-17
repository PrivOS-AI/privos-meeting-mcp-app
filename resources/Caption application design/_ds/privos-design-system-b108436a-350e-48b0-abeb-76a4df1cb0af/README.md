# PrivOS — Design System

> **Lean to Scale.** The brand operating system for PrivOS: tokens, type, color, iconography, and UI kits for building privacy-grade interfaces and on-brand assets.

---

## 1. Company / Product Context

**PrivOS** is the **AI Operating System for Enterprise** — one self-hosted platform that replaces 5–7 fragmented SaaS tools, where **human teams and AI agents collaborate as one workforce**. The tagline is **"Lean to Scale."** The identity reads as *infrastructure-grade*: confident, technical, and trustworthy, with a premium metallic finish. The brand pairs a deep-space navy ground with a signature **gold→silver gradient** that runs through the logo mark, app icons, and key accents.

The product consolidates six pillars — **Chat, Smart List & Data, Documents & Files, AI Bot Agents, MCP Apps, and Sandbox** — and can deploy on secured cloud, self-hosted on your own servers, or fully **air-gapped**. Its headline promises: replace 6+ tools in one, **cut SaaS costs up to 75%**, and **boost team productivity ~300%**. AI agents are room-scoped, permission-bounded, fully auditable (GDPR / HIPAA / SOC 2), with human-in-the-loop controls. Source: <https://privos.ai/>.

The **mark** is a stylised lowercase **"p"** built from an open ring with a descending stem — evoking an orbit, a keyhole, and a power symbol at once. It always renders in the gold→silver gradient on dark, or as a solid (black/white) on flat surfaces.

> **Note on scope:** This system was assembled from a brand kit (logos, app icons, favicons, a ~470-icon Fluent-style line library, color tokens, and the Montserrat typeface) plus the public marketing copy/structure at <https://privos.ai/>. **No product codebase or Figma file was provided.** The UI kits here are therefore *faithful brand-derived interpretations* — the marketing kit follows the real site's content and section order; the product kit mocks a representative workspace (chat + agents + lists). Treat them as a high-fidelity starting point; swap in real product structure/screens when available.

### Sources provided
- **Logos:** `Logo full color/black/white.svg` (PrivOS wordmark)
- **Favicons / marks:** `Favicon color/black/white.svg`, `privos-favicon.svg`
- **App icons:** `App icon.png` (near-black bg), `App icon-1.png` (navy bg)
- **Icon library:** ~470 SVG line icons (Fluent System Icons style) + brand logos (Apple, Google, GitHub, etc.)
- **Color tokens:** Gold `#FFC814`, Blue `#3C82E6`, Navy `#001930`, gradient `gold→#DCDCDC`
- **Typeface:** [Montserrat](https://fonts.google.com/specimen/Montserrat) (Google Fonts)

---

## 2. Content Fundamentals — voice & copy

PrivOS copy is **confident, lean, and enterprise-technical.** It sounds like a platform that respects the reader's time and intelligence, and speaks the language of IT, security, and operations leaders.

- **Tone:** Direct and declarative. Short sentences. Verb-forward. Favors the *imperative* ("Replace 5–7 tools.", "Deploy on your servers.") and crisp, quantified value claims ("Cut SaaS costs 75%", "300% productivity boost") over hype.
- **Person:** Speaks to **"you"** / **"your team"** (the enterprise buyer); refers to the product as **"PrivOS"** or **"the platform / the OS."** "We" appears only in commitments and demos ("We'll demo the full platform…").
- **Casing:** **Sentence case** for body and most headings; the site uses **Title Case** for short section labels and feature names (Chat, Smart List & Data, AI Bot Agents). Eyebrows / section badges are short and tracked.
- **Signature phrases:** *AI Operating System for Enterprise; Where teams & AI agents collaborate; the future of work; one platform, one perimeter; room-scoped, permission-bounded, fully auditable; sense → think → act; self-hosted, cloud, or air-gapped.*
- **Numerals & specifics:** Lean hard on concrete numbers (6-in-1, 75%, 300%, 18 events, $81/user/mo, GDPR/HIPAA/SOC 2). Each claim ties to a proof point.
- **Emoji:** **None** in UI/marketing chrome. Meaning comes from the icon library and color.
- **Vibe words:** *autonomous, agentic, sovereign, air-gapped, consolidated, lean, enterprise, secure, orchestrate.*

**Examples (in-voice):**
- Headline: *"Where teams & AI agents collaborate."*
- Sub: *"Replace 5–7 SaaS tools with one platform. Deploy on your servers, cloud, or fully air-gapped."*
- Button: *"Request a demo"* / *"Explore the platform"* / *"Book a discovery call"*
- Eyebrow: *"THE AI OPERATING SYSTEM FOR ENTERPRISE"*
- Proof: *"Cut SaaS costs 75%. Boost your team 300%."*

---

## 3. Visual Foundations

**Color.** Two grounds: the **navy canvas** (`#001930`, used for hero, app shell, marketing) and **light navy-tinted neutrals** (`--navy-50/100`, used for dense product UI). **Gold `#FFC814` is the brand spark** — used sparingly for the mark, key emphasis, and one hero accent per view; it is *not* the primary action color. **Blue `#3C82E6` is the interactive color** — buttons, links, focus rings, selection. The **gold→silver gradient** is reserved for the mark, premium surfaces, and occasional display-text washes; never for body text or as a full-page background wash (avoid AI-gradient-soup).

**Type.** **Montserrat** throughout — geometric, even, slightly wide, restricted to **three weights: 500 / 600 / 700**. Display and headings run **Bold 700** with **tight tracking** (−0.02 to −0.03em) so big type feels engineered, not airy. Body is **Medium 500** at comfortable 1.55–1.6 line height; sub-headings use **SemiBold 600**. Mono (JetBrains Mono) for code, keys, hashes, and technical chips.

**Spacing.** 4px base grid. Generous outer padding on marketing (80–96px section rhythm); tighter, 8–16px rhythm in product UI. Components breathe — privacy/infra brands read as *calm*, not cramped.

**Backgrounds.** Predominantly **flat** navy or near-white — *no* photographic hero washes by default. Texture comes from: (1) subtle **navy elevation layers**, (2) a faint **dot/grid field** on dark heroes, and (3) the **mark used large at low opacity** as a watermark. The gold→silver gradient appears as a thin top-border or a single glowing accent, not a full background.

**Borders & cards.** Hairline borders (`--navy-100/200` on light, `rgba(255,255,255,.10)` on dark). Cards are **radius 10–16px**, white (or navy-raised) with **cool, navy-cast shadows** (never warm/gray) — soft and low, `--shadow-sm/md`. Premium cards may carry a **1px gradient top-edge** or a faint **gold/blue glow** (`--shadow-glow-*`) on hover.

**Radii.** Inputs **6–10px**, **buttons are full pills (999px)**, cards **10–16px**, modals **16–24px**. Consistent, moderately rounded — not sharp.

**Buttons.** The **primary button carries the signature gold→silver gradient with navy ink** — the brand moment, used once or twice per view; hover adds a soft gold glow. Secondary actions use solid interactive **blue**; tertiary use light-outline or ghost. All buttons are pill-shaped.

**Elevation / shadows.** All shadows are **navy-tinted and cool** (`rgba(0,25,48,…)`), low and diffuse. Glow shadows (gold or blue) signal *active / premium / focus* states only.

**Transparency & blur.** Used deliberately: sticky nav over dark uses `backdrop-filter: blur` + `rgba(0,25,48,.7)`; overlays/scrims use navy at 50–70%. Light UI rarely blurs.

**Animation.** Quiet and precise. **120–240ms**, easing `cubic-bezier(.2,.7,.2,1)` (ease-out, slight settle). Fades + small translateY (4–8px) for entrance; **no bounce, no spring overshoot**, no infinite decorative loops. The mark may draw-in once on load.

**Interaction states.**
- *Hover:* darken blue by one step (`--privos-blue-deep`) or raise surface + show shadow; ghost/secondary buttons fill with a 6–8% blue tint.
- *Press:* slight darken + `transform: translateY(1px)` (no scale-down past 0.99).
- *Focus:* 2px `--privos-blue` ring with 2px offset (never remove outlines).
- *Selected:* blue tint bg + blue left/under accent.

**Imagery vibe.** When photography is used: **cool, desaturated, high-contrast**, with a faint navy duotone — server rooms, hardware, abstract light. No warm stock, no lifestyle clichés.

**Layout rules.** Fixed top nav on marketing; fixed left rail + top bar in product. Max content width ~1200px for marketing. Grid-first; generous gutters.

---

## 4. Iconography

PrivOS ships a **single, coherent line-icon library (~470 glyphs)** in the **Microsoft Fluent System Icons** visual idiom:

- **Style:** Outlined / stroked, **24×24 viewBox**, **1.5px stroke**, **round caps + round joins**, optically balanced. A few glyphs use small solid fills for legibility (e.g. the keyhole dot in `shield-keyhole`).
- **Ink color:** Source files stroke in near-black `#080D0F` (`--privos-ink`). **Recolor by setting `stroke`/`color`** — icons are designed to take `currentColor`-style theming. On dark UI, render white or `--navy-200`; for emphasis, `--privos-blue`; for the rare brand moment, gold.
- **Format:** Inline **SVG** files (in `assets/icons/`). No icon *font*, no PNG icons, **no emoji**, no unicode-glyph substitution. Always use the real SVGs.
- **Brand logos:** The set also includes flat third-party brand marks (`apple`, `google`, `github`, `amazon`, `x-twitter`, `figma`, language/tool logos, etc.) for integrations and social.
- **Sizing:** 16 / 20 / 24px in UI; 28–40px for feature bullets. Keep the 1.5px stroke visually consistent — scale the SVG, don't re-weight.
- **Usage:** One icon per action; pair with sentence-case labels. Don't mix this line set with filled/duotone icons from other libraries.

To use: copy the SVG out of `assets/icons/` and inline it (so you can set `stroke`/`fill`), or reference via `<img>` when recoloring isn't needed.

---

## 5. Index — what's in this system

| File / folder | What it is |
|---|---|
| `README.md` | This document — context, voice, visual foundations, iconography, index |
| `colors_and_type.css` | All design tokens: color, gradient, neutrals, semantic, shadow, radius, spacing, type scale + helper classes |
| `SKILL.md` | Agent Skill manifest (for use in Claude Code) |
| `assets/brand/` | Logos (color/black/white), favicons, app icons, mark |
| `assets/icons/` | ~470 Fluent-style line SVGs + third-party brand logos |
| `preview/` | Design System tab cards (color, type, spacing, components, brand) |
| `ui_kits/marketing/` | Marketing site kit — hero (teams + AI agents), six pillars, security, economics, CTA, footer |
| `ui_kits/app/` | Product console kit — workspace shell, Chat (human + AI agents), Smart Lists, AI Agents, settings |

### Fonts
Montserrat & JetBrains Mono load from Google Fonts via `colors_and_type.css`. If you need offline/embedded files, request them — they are not bundled here.
