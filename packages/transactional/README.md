# Transactional emails

React Email templates and rendering shared by application services. SMTP delivery and credentials belong to the calling service, not this package.

From the repository root:

```sh
just email-dev
just typecheck
```

The preview server opens at `http://localhost:3002`. Templates live in `emails/` with preview props; `src/index.tsx` exports rendering functions returning a subject, HTML and plain text. Import `renderSignInEmail` from `@pfe/transactional` in server-side delivery code.

The private Bun workspace exports TypeScript source, compiled by the consuming application's bundler. Use the root lockfile and pinned React version. The preview UI is a development dependency and requires no SMTP credentials.

Setup follows [React Email's workspace guide](https://react.email/docs/getting-started/monorepo-setup).
