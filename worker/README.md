# SoloSync OAuth callback

This Worker provides the fixed HTTPS callback required by browser-hosted VS Code environments. It never proxies backup files and has no database or KV binding.

Google Cloud must provide a **Web application** OAuth client with this exact authorized redirect URI:

```text
https://solosync.szlk.uk/oauth/google/callback
```

Deploy-time configuration:

- `GOOGLE_WEB_CLIENT_ID`: Worker variable; public identifier.
- `GOOGLE_WEB_CLIENT_SECRET`: Worker secret; never commit it.
- `OAUTH_SEALING_KEY`: Worker secret containing 32 random bytes encoded as Base64.

The extension creates a PKCE verifier. The callback page displays a short-lived encrypted SoloSync code bound to that verifier. After redemption, the Worker returns an opaque encrypted credential. Google refresh tokens are never returned as plaintext or persisted by the Worker.
