# nodebb-plugin-sso-azure-external-id

> Sign in with Microsoft via **Azure Entra External ID** (formerly Azure AD External Identities / CIAM) for NodeBB.

[![NodeBB compatibility](https://img.shields.io/badge/nodebb-%5E3.0.0%20%7C%7C%20%5E4.0.0-blue)](https://nodebb.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why this plugin?

Existing NodeBB SSO plugins for Microsoft/Azure either target Azure AD (workforce tenants) or are generic OAuth2 wrappers that need significant manual configuration to work with **Entra External ID** (CIAM) tenants. Common pain points:

| Problem | How this plugin solves it |
|---|---|
| CIAM authority hostname not recognised by MSAL | Sets `knownAuthorities` automatically from the configured authority — the step most community plugins miss |
| `sub` claim can rotate in CIAM tenants | Uses `oid` (object ID) as the stable user key |
| No PKCE support in generic SSO plugins | Full Authorization Code + PKCE (S256) via MSAL's `CryptoProvider` |
| Email might arrive as `preferred_username` | Falls back automatically |
| No admin-panel UI | Settings page in the NodeBB ACP, no config file editing |

Uses **`@azure/msal-node`** — Microsoft's official authentication library for server-side Node.js. No generic OIDC wrapper.

---

## Requirements

- **NodeBB** v3.x or v4.x
- **Node.js** ≥ 18
- An **Azure Entra External ID** tenant (free tier is fine)

---

## Installation

```bash
# From your NodeBB directory:
npm install nodebb-plugin-sso-azure-external-id

# Then activate the plugin in the NodeBB Admin Control Panel:
# ACP → Extend → Plugins → search "azure-external-id" → Activate → Rebuild & Restart
```

---

## Azure setup

### 1. Create (or reuse) an app registration

In your [Azure portal](https://portal.azure.com):

1. Go to your **Entra External ID** tenant → **App registrations** → **New registration**.
2. Set the **Redirect URI** platform to **Web** and enter:
   ```
   https://<your-forum-domain>/auth/azure-ext-id/callback
   ```
3. Under **Certificates & secrets** → **Client secrets** → **New client secret**. Copy the value immediately.
4. Under **Token configuration** → **Add optional claim** → **ID token**, add:
   - `email`
   - `name`
   - `preferred_username`
5. The `oid` claim is always present in ID tokens by default — no extra configuration needed.

### 2. Find your Authority URL

The authority URL format for Entra External ID is:

```
https://<tenant-name>.ciamlogin.com/
```

Just the base hostname — **do not** append a tenant path or `/v2.0` suffix. The plugin passes this directly to `@azure/msal-node`, which handles OIDC endpoint discovery internally.

You can confirm your tenant name in the Azure portal: **Overview** of your Entra External ID tenant → the **Primary domain** field (e.g. `contoso.onmicrosoft.com` → tenant name is `contoso`).

---

## NodeBB configuration

Go to **ACP → Plugins → Azure Entra External ID SSO** and fill in:

| Field | Description |
|---|---|
| **Authority URL** | Base CIAM authority, e.g. `https://contoso.ciamlogin.com/` — no path, no `/v2.0` |
| **Client ID** | The app registration's Application (client) ID |
| **Client Secret** | The secret you created in step 3 above |
| **Redirect URI** | Leave blank to use the default `{forum-url}/auth/azure-ext-id/callback` |
| **Login Button Label** | Text shown on the login button (default: `Microsoft`) |
| **Auto-link existing accounts** | Links CIAM logins to existing NodeBB accounts with the same email |

Click **Save Settings**. No NodeBB restart required.

### Environment variable fallbacks

If you prefer not to store credentials in the database, the plugin reads the following environment variables when the admin settings are empty:

```env
AZURE_ENTRA_AUTHORITY=https://<tenant>.ciamlogin.com/
AZURE_ENTRA_CLIENT_ID=<your-client-id>
AZURE_ENTRA_CLIENT_SECRET=<your-client-secret>
AZURE_ENTRA_CALLBACK_URL=https://<forum>/auth/azure-ext-id/callback  # optional
```

For compatibility with existing setups, these legacy names also work:

```env
AZURE_AD_AUTHORITY=https://<tenant>.ciamlogin.com/
AZURE_AD_CLIENT_ID=<your-client-id>
AZURE_AD_CLIENT_SECRET=<your-client-secret>
```

> **Important:** Use just `https://<tenant>.ciamlogin.com/` as the authority — no tenant path, no `/v2.0` suffix. If a `/v2.0` suffix is present in the stored or environment value, the plugin strips it automatically to avoid a `GET not accepted` error from the Entra endpoint.

---

## How it works

```
User clicks "Sign in with Microsoft"
        │
        ▼
GET /auth/azure-ext-id
  • generates PKCE code_verifier + code_challenge (S256)
  • generates CSRF state token
  • stores both in the Express session
  • redirects → Entra /authorize endpoint
        │
        ▼  (user authenticates with Microsoft)
        │
GET /auth/azure-ext-id/callback?code=...&state=...
  • validates state (CSRF check)
  • exchanges code for tokens using code_verifier (PKCE)
  • validates ID token (signature, issuer, audience, expiry)
  • extracts `oid` (stable user key), `email`, `name`
  • finds or creates NodeBB user:
      ↳ existing oid mapping → return uid
      ↳ email match + autoLink → link and return uid
      ↳ new account → user.create(), store oid→uid mapping
  • calls authController.doLogin(req, uid)
  • redirects to forum home (or returnTo)
```

### Why `@azure/msal-node` and not a generic OIDC library?

Most community NodeBB SSO plugins use a generic OIDC client (e.g., `passport-openidconnect`, `openid-client`). These work fine for standard Entra workforce tenants but break silently with Entra External ID (CIAM) because:

1. **`knownAuthorities` is required.** MSAL maintains an allow-list of trusted authority hostnames. CIAM tenants use `<tenant>.ciamlogin.com`, which is not on that list. Generic libraries either skip this check or fail in a confusing way. MSAL exposes `knownAuthorities` explicitly and this plugin sets it automatically.

2. **Authority URL format.** MSAL handles OIDC metadata discovery internally from the base authority URL — you do **not** provide a discovery URL or `/v2.0` suffix yourself. Generic OIDC libraries need the full discovery URL, which is a common source of misconfiguration.

3. **Official support.** When something breaks, the Microsoft docs, GitHub issues, and support channels all speak MSAL.

### Why `oid` and not `sub`?

In Azure Entra External ID (CIAM) tenants, the `sub` claim is **application-specific** — the same user will have a different `sub` for each app registration. More importantly, Microsoft reserves the right to change `sub` values in certain CIAM scenarios. The `oid` (object ID) is **guaranteed stable** for the lifetime of the user in the tenant and is the same across all app registrations in the same tenant.

---

## Database schema

The plugin stores a single hash in NodeBB's database:

```
sso-azure-external-id:oid:uid  →  { "<entra-oid>": "<nodebb-uid>", ... }
```

This allows O(1) lookup on every login after the first one. The hash is never deleted unless you manually clean it up.

---

## Troubleshooting

### "Plugin is not fully configured"
Go to ACP → Plugins → Azure Entra External ID SSO and fill in all three required fields (Authority URL, Client ID, Client Secret).

### `AADSTS900561` — "The endpoint only accepts POST requests"
The authority URL has a tenant path appended (e.g. `https://contoso.ciamlogin.com/contoso.onmicrosoft.com/`). For Entra External ID (CIAM), use just the base URL: `https://contoso.ciamlogin.com/`.

### `missing_oid` error after callback
The `oid` claim is missing from the ID token. In the Azure portal, verify that your app registration is in an **Entra External ID** tenant (not a workforce/B2B tenant). In workforce tenants, `oid` is present but labelled differently.

### `missing_email` error after callback
The plugin tries these claims in order: `email`, `preferred_username`, `emails`, `signInNames.emailAddress`. If your tenant uses a different attribute name, update the **Email claim** field in ACP → Plugins → Azure Entra External ID SSO. You can also add `email` and `preferred_username` as optional claims on the ID token in the Azure portal (Token configuration → Add optional claim) to avoid needing to change anything here.

### PKCE / state mismatch (`oidc_validation_failed`)
Usually caused by the user refreshing the callback URL or using multiple tabs. The flow restarts cleanly — ask the user to click "Sign in with Microsoft" again.

### `session_expired` error
The user's session expired between starting the OAuth flow and returning from Entra. NodeBB's session TTL is configurable in ACP → Settings → Session.

---

## Contributing

PRs and issues welcome. The plugin targets NodeBB v3.x and v4.x. When testing locally, point `AZURE_ENTRA_AUTHORITY` etc. at a development tenant.

## Support

We built this plugin because we needed it, and we're sharing it in that spirit. If something's broken, PRs are welcome. If you need hands-on help integrating it into your setup — configuration, customisation, or anything else — that's consulting work and we charge an hourly rate. Reach out via the repository if you'd like a quote.

---

## License

MIT
