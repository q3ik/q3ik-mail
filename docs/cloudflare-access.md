# Cloudflare Access — q3ik-mail Configuration Guide

This document captures the Cloudflare Zero Trust / Access settings for the
`q3ik-mail` application, explains the security rationale for each setting,
and provides a checklist for the manual dashboard steps that cannot be
managed via code.

> ⚠️ **Never commit the AUD tag or Application ID to this file.**
> Retrieve them from the Cloudflare Zero Trust dashboard and store the
> AUD value exclusively as a Worker secret (`wrangler secret put`).

---

## Access Application: `q3ik-mail`

| Field | Value |
|---|---|
| Application URL | `q3ik-mail.pages.dev` |
| Type | Self-Hosted |
| Application ID | *(retrieve from Zero Trust → Access → Applications → q3ik-mail)* |
| Policy | `owner-only` (Allow, 2 emails included) |
| Session Duration | 24 hours |

---

## AUD Tag

The AUD (audience) tag uniquely identifies this Access application. It is
used to validate the `CF_Access_Jwt_Assertion` header in the Worker.

**Do not store the AUD value here.** Retrieve it from:
**Zero Trust → Access → Applications → q3ik-mail → Edit → Overview → Application ID / AUD Tag**

Store it as a Worker secret only:

```sh
# From apps/worker/
npx wrangler secret put CLOUDFLARE_ACCESS_AUD
# paste the AUD value from the dashboard — do not write it in this file
```

---

## Cookie Settings — Manual Dashboard Checklist

Navigate to: **Zero Trust → Access → Applications → q3ik-mail →
Additional Settings → Cookie settings**

| Setting | Required Value | Rationale |
|---|---|---|
| **HTTP Only** | ✅ ON | Prevents client-side JS from reading the CF Access JWT cookie. Mitigates XSS-based token theft. |
| **Enable Binding Cookie** | ✅ ON | Binds the JWT to the user's TLS session. Prevents token replay from a different origin. Safe for web apps; avoid for SSH/RDP apps. |
| **Enforce cookie path attribute** | OFF (default) | Scopes to hostname by default — fine for a single-app deployment. |
| **Same Site Attribute** | `Lax` or `Strict` recommended | Set to at least `Lax` to prevent CSRF via cross-site navigation. |

> **Note:** These settings are Cloudflare dashboard-only. There is no
> Terraform / Wrangler equivalent for Access application cookie settings.

---

## Service Authentication

- **Return 401 Response**: OFF (default) — keeps the redirect-to-login UX.
  Turn ON only if this app is consumed by machine clients that need a 401
  instead of a redirect.

---

## Worker: Cloudflare Access JWT Validation

The Worker validates the `CF_Access_Jwt_Assertion` JWT on every inbound
request. See `apps/worker/src/middleware/cfAccess.ts`.

Required Worker secrets / vars:

| Name | Type | Where to get the value |
|---|---|---|
| `CLOUDFLARE_ACCESS_AUD` | Secret (`wrangler secret put`) | Zero Trust → Access → Applications → q3ik-mail → AUD Tag |
| `CLOUDFLARE_TEAM_DOMAIN` | Var (`wrangler.toml`) | Zero Trust → Settings → Custom Pages → Team domain |

Set the secret:
```sh
# From apps/worker/
npx wrangler secret put CLOUDFLARE_ACCESS_AUD
```

Update `wrangler.toml` with your actual team domain:
```toml
[vars]
CLOUDFLARE_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
```

---

## Custom Domain Access Application

When `q3ik-mail` is served from a custom domain (e.g. `mail.q3ik.com`),
a **second Access Application** must be created to protect it. The
`q3ik-mail.pages.dev` application only covers the `.pages.dev` origin.

Steps:
1. Add a DNS CNAME record: `mail.q3ik.com → <pages-project>.pages.dev`
2. In Zero Trust → Access → Applications, create a new Self-Hosted app:
   - Application URL: `mail.q3ik.com`
   - Policy: same `owner-only` policy
   - Cookie settings: same hardened values above
3. Update the Pages project's custom domain in the Cloudflare Pages dashboard.
4. Run `npx wrangler secret put CLOUDFLARE_ACCESS_AUD` with the **new** AUD tag
   (each Access application has a unique AUD — do not reuse the old one).

---

## Infrastructure Security Center

As of the last scan (28 Apr 2026), the following domains show **"Not
Secured"** (no Access policy) in the Security Center inventory:

- `q3ik.com`
- `www.q3ik.com`
- `_domainconnect.q3ik.com`

These are the marketing/root domain — they do not need Access unless you
add private content there. Acknowledged and intentional.

---

## Posture Checks

Two posture checks exist in Zero Trust (Gateway + WARP) but are not
currently applied to any policy. To require WARP to be running before
accessing the app, add a `Require` rule to the `owner-only` policy:

- Rule type: **Device Posture**
- Check: **WARP**
