'use strict';

/**
 * nodebb-plugin-sso-azure-external-id
 *
 * Adds "Sign in with Microsoft" to NodeBB using Azure Entra External ID (CIAM).
 * Uses @azure/msal-node (Microsoft's official auth library) for the
 * Authorization Code + PKCE flow.
 *
 * Key design decisions vs. generic OIDC plugins:
 *  • Uses `@azure/msal-node` — the canonical Microsoft library for server-side
 *    Node.js apps. Handles Entra-specific authority/endpoint quirks correctly.
 *  • `knownAuthorities` is set automatically from the authority URL. This is
 *    the step most community attempts miss — MSAL will reject CIAM authorities
 *    unless their hostname is in the known list.
 *  • Uses the `oid` claim (Entra object ID) as the stable user key. `sub` is
 *    application-scoped and can rotate in CIAM tenants; `oid` never does.
 *  • PKCE (S256) is implemented via MSAL's `CryptoProvider` — the code_verifier
 *    is stored server-side (session) and never sent to the browser.
 *  • State parameter is manually tracked in the session for CSRF protection
 *    (MSAL generates the auth URL but does not validate state on the callback).
 *
 * NodeBB compatibility: v3.x / v4.x
 * Node.js requirement: ≥ 18
 */

const msal = require('@azure/msal-node');
const { randomBytes } = require('crypto');

// NodeBB internals — resolved lazily because NodeBB loads plugins before its
// own modules finish booting. Always call as functions: nconf(), winston(), …
const nconf        = () => require.main.require('nconf');
const winston      = () => require.main.require('winston');
const meta         = () => require.main.require('./src/meta');
const db           = () => require.main.require('./src/database');
const userModule   = () => require.main.require('./src/user');
const authCtrl     = () => require.main.require('./src/controllers/authentication');
const routeHelpers = () => require.main.require('./src/routes/helpers');

const PLUGIN_ID = 'sso-azure-external-id';

// NodeBB hash: maps Entra oid → NodeBB uid (O(1) lookup on every login)
const DB_OID_MAP = `${PLUGIN_ID}:oid:uid`;

// ── Cached MSAL app ───────────────────────────────────────────────────────────
//
// ConfidentialClientApplication is stateful (token cache, discovery cache),
// so we reuse the same instance as long as the configuration hasn't changed.

let _msalApp    = null;
let _msalAppKey = '';   // "<authority>::<clientId>" sentinel

async function getMsalApp () {
  const s = await getSettings();

  if (!s.authority || !s.clientId || !s.clientSecret) {
    throw new Error(
      `[${PLUGIN_ID}] Plugin is not fully configured. ` +
      'Set "Authority URL", "Client ID", and "Client Secret" in ACP → Plugins → ' +
      `${PLUGIN_ID}.`,
    );
  }

  const key = `${s.authority}::${s.clientId}`;
  if (_msalApp && _msalAppKey === key) return _msalApp;

  // ── knownAuthorities is the critical CIAM setting ──────────────────────────
  //
  // MSAL validates the authority hostname against a built-in allow-list of
  // Microsoft-owned domains. Entra External ID tenants use the pattern
  //   <tenant>.ciamlogin.com
  // which is not on that list. Adding the hostname to knownAuthorities tells
  // MSAL to trust it. Without this, every login attempt fails with:
  //   "The provided authority is not recognized by MSAL."
  const authorityHostname = new URL(s.authority).hostname;

  const config = {
    auth: {
      clientId:        s.clientId,
      clientSecret:    s.clientSecret,
      authority:       s.authority,
      knownAuthorities: [authorityHostname],
    },
    system: {
      loggerOptions: {
        // Route MSAL internal logs through NodeBB's logger so they appear in
        // the NodeBB log stream rather than going to console.error.
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;  // never log PII
          const log = winston();
          switch (level) {
            case msal.LogLevel.Error:   log.error(`[msal] ${message}`);   break;
            case msal.LogLevel.Warning: log.warn(`[msal] ${message}`);    break;
            case msal.LogLevel.Info:    log.info(`[msal] ${message}`);    break;
            default:                    log.verbose(`[msal] ${message}`); break;
          }
        },
        logLevel: msal.LogLevel.Warning,
        piiLoggingEnabled: false,
      },
    },
  };

  winston().info(
    `[${PLUGIN_ID}] Initialising MSAL ConfidentialClientApplication ` +
    `(authority: ${s.authority}, knownAuthority: ${authorityHostname})`,
  );

  _msalApp    = new msal.ConfidentialClientApplication(config);
  _msalAppKey = key;
  return _msalApp;
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSettings () {
  const stored    = await meta().settings.get(PLUGIN_ID);
  const forumUrl  = nconf().get('url') || '';

  // NOTE: MSAL expects the authority WITHOUT a trailing /v2.0 suffix.
  // (openid-client needed /v2.0 for OIDC discovery; MSAL handles that
  // internally.) If the stored/env value has /v2.0, strip it.
  const rawAuthority =
    stored.authority                  ||
    process.env.AZURE_ENTRA_AUTHORITY ||
    process.env.AZURE_AD_AUTHORITY    ||
    '';
  const authority = rawAuthority.replace(/\/v2\.0\/?$/, '').replace(/\/$/, '');

  return {
    authority,
    clientId: stored.clientId
      || process.env.AZURE_ENTRA_CLIENT_ID
      || process.env.AZURE_AD_CLIENT_ID
      || '',
    clientSecret: stored.clientSecret
      || process.env.AZURE_ENTRA_CLIENT_SECRET
      || process.env.AZURE_AD_CLIENT_SECRET
      || '',
    // The OAuth2 redirect URI — must be registered in the Azure portal.
    callbackUrl: stored.callbackUrl
      || process.env.AZURE_ENTRA_CALLBACK_URL
      || `${forumUrl}/auth/azure-ext-id/callback`,
    buttonLabel: stored.buttonLabel || 'Microsoft',
    // When true, a first-time CIAM login links to an existing NodeBB account
    // that shares the same email rather than creating a duplicate.
    autoLink: stored.autoLink !== 'false',

    // ── Claim mappings ──────────────────────────────────────────────────────
    // Comma-separated fallback lists. The plugin tries each name in order and
    // uses the first non-empty value it finds in the ID token. Admins can
    // customise these in the ACP if their tenant delivers claims differently.

    // Stable user identifier. oid is always present and never rotates in CIAM.
    claimOid:   stored.claimOid   || 'oid',

    // Email address. CIAM tenants vary: some put it in `email`, others in
    // `preferred_username`. Try both. `emails` is an array used by some B2C-
    // adjacent flows; `signInNames.emailAddress` by legacy B2C custom policies.
    claimEmail: stored.claimEmail || 'email,preferred_username,emails,signInNames.emailAddress',

    // Display name. If `name` is missing, the plugin falls back to
    // concatenating given_name + family_name automatically.
    claimName:  stored.claimName  || 'name,displayName',

    // Username to use in NodeBB. Leave blank to derive from display name / email.
    // Set to e.g. `nickname` or a custom claim if your tenant emits one.
    claimUsername: stored.claimUsername || '',
  };
}

// ── Claim extraction ──────────────────────────────────────────────────────────

/**
 * Picks the first non-empty value from `rawClaims` for the given comma-
 * separated list of candidate claim names.
 *
 * Handles three shapes Entra CIAM can use for the same attribute:
 *   • string  — "alice@example.com"
 *   • string[] — ["alice@example.com"]     (some B2C-adjacent flows use arrays)
 *   • dot-path — "signInNames.emailAddress" (legacy B2C custom policy claims)
 */
function pickClaim (rawClaims, csvKeys) {
  for (const key of csvKeys.split(',').map(k => k.trim()).filter(Boolean)) {
    // Dot-path: e.g. "signInNames.emailAddress"
    const parts = key.split('.');
    let value = rawClaims;
    for (const part of parts) {
      if (value == null || typeof value !== 'object') { value = undefined; break; }
      value = value[part];
    }

    if (Array.isArray(value))                        value = value[0];
    if (typeof value === 'string' && value.trim())   return value.trim();
  }
  return null;
}

/**
 * Extracts the four user attributes we care about from the raw ID token
 * claims, using the admin-configured claim mapping with graceful fallbacks.
 *
 * Returns null for `username` if the admin hasn't mapped a dedicated claim —
 * `buildUniqueUsername` will derive one from displayName / email instead.
 */
function extractClaims (rawClaims, settings) {
  const oid   = pickClaim(rawClaims, settings.claimOid);
  const email = pickClaim(rawClaims, settings.claimEmail)?.toLowerCase() ?? null;

  // Display name: try configured claims first, then fall back to
  // concatenating given_name + family_name (common when `name` is not
  // included as an optional claim).
  let displayName = pickClaim(rawClaims, settings.claimName);
  if (!displayName) {
    const given  = (rawClaims.given_name  || '').trim();
    const family = (rawClaims.family_name || '').trim();
    if (given || family) displayName = [given, family].filter(Boolean).join(' ');
  }

  const username = settings.claimUsername
    ? pickClaim(rawClaims, settings.claimUsername)
    : null;

  return { oid, email, displayName: displayName || null, username };
}

// ── Plugin hooks ──────────────────────────────────────────────────────────────

const plugin = module.exports;

/**
 * static:app.load — registers all Express routes for the OAuth2 flow.
 */
plugin.init = async function ({ router }) {
  const cryptoProvider = new msal.CryptoProvider();

  // ── Start auth flow ───────────────────────────────────────────────────────
  router.get('/auth/azure-ext-id', async function (req, res, next) {
    if (req.loggedIn) return res.redirect(nconf().get('url'));

    try {
      const app = await getMsalApp();
      const s   = await getSettings();

      // Generate PKCE codes via MSAL's CryptoProvider.
      // verifier  — stored server-side in the session, never exposed to browser.
      // challenge — sent to Entra as part of the authorization request.
      const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

      // Random state for CSRF protection.
      const state = randomBytes(16).toString('hex');

      req.session[`${PLUGIN_ID}:state`]    = state;
      req.session[`${PLUGIN_ID}:verifier`] = verifier;

      if (req.query.returnTo) {
        req.session[`${PLUGIN_ID}:returnTo`] = req.query.returnTo;
      }

      const authCodeUrl = await app.getAuthCodeUrl({
        scopes:              ['openid', 'profile', 'email'],
        redirectUri:         s.callbackUrl,
        codeChallenge:       challenge,
        codeChallengeMethod: 'S256',
        state,
      });

      res.redirect(authCodeUrl);
    } catch (err) {
      winston().error(`[${PLUGIN_ID}] Failed to build auth URL:`, err.message);
      next(err);
    }
  });

  // ── OAuth2 callback ───────────────────────────────────────────────────────
  router.get('/auth/azure-ext-id/callback', async function (req, res, next) {
    const savedState    = req.session[`${PLUGIN_ID}:state`];
    const savedVerifier = req.session[`${PLUGIN_ID}:verifier`];
    const returnTo      = req.session[`${PLUGIN_ID}:returnTo`] || nconf().get('url');

    delete req.session[`${PLUGIN_ID}:state`];
    delete req.session[`${PLUGIN_ID}:verifier`];
    delete req.session[`${PLUGIN_ID}:returnTo`];

    // Entra returned an error (user cancelled, policy blocked, etc.)
    if (req.query.error) {
      winston().warn(
        `[${PLUGIN_ID}] Auth error from Entra: ${req.query.error} — ` +
        (req.query.error_description || ''),
      );
      return res.redirect(
        `${nconf().get('url')}/login?error=entra_${req.query.error}`,
      );
    }

    // No state in session = user hit the callback without starting the flow
    // (e.g., page refresh or direct URL visit).
    if (!savedState || !savedVerifier) {
      return res.redirect(`${nconf().get('url')}/login?error=session_expired`);
    }

    // ── CSRF check ────────────────────────────────────────────────────────────
    // MSAL builds the auth URL with a state param but does NOT validate it on
    // the callback side — we must do this ourselves.
    if (req.query.state !== savedState) {
      winston().warn(`[${PLUGIN_ID}] State mismatch — possible CSRF attempt`);
      return res.redirect(`${nconf().get('url')}/login?error=state_mismatch`);
    }

    try {
      const app = await getMsalApp();
      const s   = await getSettings();

      const response = await app.acquireTokenByCode({
        code:         req.query.code,
        scopes:       ['openid', 'profile', 'email'],
        redirectUri:  s.callbackUrl,
        codeVerifier: savedVerifier,
      });

      const { oid, email, displayName, username } = extractClaims(response.idTokenClaims, s);

      if (!oid) {
        winston().warn(
          `[${PLUGIN_ID}] ID token missing OID claim (looked in: ${s.claimOid}). ` +
          'Check token configuration in the Azure portal, or adjust the "OID claim" ' +
          'setting in ACP → Plugins → Azure Entra External ID SSO.',
        );
        return res.redirect(`${nconf().get('url')}/login?error=missing_oid`);
      }

      if (!email) {
        winston().warn(
          `[${PLUGIN_ID}] ID token missing email (looked in: ${s.claimEmail}). ` +
          'Add "email" and "preferred_username" as optional claims on the ID token in ' +
          'Azure portal → App registration → Token configuration, or adjust the ' +
          '"Email claim" setting in the plugin ACP.',
        );
        return res.redirect(`${nconf().get('url')}/login?error=missing_email`);
      }

      const uid = await findOrCreateUser({
        oid,
        email,
        displayName,
        username,
        autoLink: s.autoLink,
      });

      await authCtrl().doLogin(req, uid);
      winston().verbose(`[${PLUGIN_ID}] Login success uid=${uid} oid=${oid}`);
      res.redirect(returnTo);
    } catch (err) {
      // MSAL surfaces auth/token errors as standard Error objects with a
      // `errorCode` or `subError` property.
      if (err.errorCode) {
        winston().warn(
          `[${PLUGIN_ID}] MSAL token acquisition failed: ${err.errorCode} — ${err.errorMessage}`,
        );
        return res.redirect(
          `${nconf().get('url')}/login?error=token_error`,
        );
      }
      next(err);
    }
  });

  // ── Admin settings page ───────────────────────────────────────────────────
  routeHelpers().setupAdminPageRoute(
    router,
    `/admin/plugins/${PLUGIN_ID}`,
    (_req, res) => res.render(`admin/plugins/${PLUGIN_ID}`, {
      title: 'Azure Entra External ID SSO',
    }),
  );

  winston().info(`[${PLUGIN_ID}] Routes registered`);
};

/**
 * filter:login.build — injects the "Sign in with Microsoft" button on the
 * login and registration pages. Only shown when the plugin is configured.
 */
plugin.addLoginButton = async function (data) {
  const s = await getSettings();
  if (!s.clientId || !s.authority) return data;

  data.templateData.authentication.push({
    url:  `${nconf().get('url')}/auth/azure-ext-id`,
    icon: 'fa-microsoft',
    name: s.buttonLabel,
  });

  return data;
};

/**
 * filter:admin.header.build — adds this plugin to the ACP sidebar navigation.
 */
plugin.addAdminNavigation = async function (header) {
  header.plugins.push({
    route: `/plugins/${PLUGIN_ID}`,
    icon:  'fa-microsoft',
    name:  'Azure Entra External ID SSO',
  });
  return header;
};

// ── User management ───────────────────────────────────────────────────────────

async function findOrCreateUser ({ oid, email, displayName, username: claimUsername, autoLink }) {
  const User = userModule();

  // Fast path: oid is already mapped to a NodeBB uid from a previous login.
  const mapped = await db().getObjectField(DB_OID_MAP, oid);
  if (mapped) return parseInt(mapped, 10);

  // Email match: link to existing account if autoLink is enabled.
  if (autoLink) {
    const existing = await User.getUidByEmail(email);
    if (existing) {
      await db().setObjectField(DB_OID_MAP, oid, existing);
      winston().info(
        `[${PLUGIN_ID}] Linked oid=${oid} to existing uid=${existing} via email match`,
      );
      return existing;
    }
  }

  // New user: create a NodeBB account.
  // Use the dedicated username claim if the admin configured one; otherwise
  // derive a username from the display name or email prefix.
  const username = await buildUniqueUsername(claimUsername || displayName, email);
  const uid = await User.create({
    username,
    email,
    fullname: displayName || username,
  });

  await db().setObjectField(DB_OID_MAP, oid, uid);
  winston().info(
    `[${PLUGIN_ID}] Created new user uid=${uid} username=${username} oid=${oid}`,
  );
  return uid;
}

async function buildUniqueUsername (displayName, email) {
  const User  = userModule();
  const source = (displayName || email.split('@')[0] || 'user')
    .replace(/[^a-zA-Z0-9 \-_.]/g, '')
    .trim()
    .slice(0, 30) || 'user';

  let candidate = source;
  let n = 1;
  while (await User.getUidByUsername(candidate)) {
    candidate = `${source}${n++}`;
  }
  return candidate;
}
