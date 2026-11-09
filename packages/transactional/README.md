# Transactional emails

React Email templates and rendering shared by application services. SMTP delivery and credentials belong to the calling service, not this package.

From the repository root:

```sh
just email-dev
just typecheck
```

The preview server opens at `http://localhost:3002`. Templates live in `emails/` with preview props; `src/index.tsx` exports rendering functions returning a subject, HTML and plain text. Import `renderSignInCodeEmail` or `renderOrganizationInvitationEmail` from `@recount/transactional` in server-side delivery code.

Both renderers require an explicit `en` or `fr` locale: `renderSignInCodeEmail(code, locale)` and `renderOrganizationInvitationEmail({ ...props, locale })`. Subjects, preview text, HTML language, body, roles and UTC expiry formatting use shared compiled catalogs from `@recount/i18n`; templates never read browser cookies or mutate global locale. The web sender resolves code-email locale before scheduling delivery. Invitations use the sender’s request locale when available, otherwise English; this does not imply a saved recipient preference. Resends follow the same policy.

The normal preview and typecheck commands compile catalogs first. Run `bun run i18n:compile` from the repository root before using renderers in other standalone tools. Generated files are ignored; English and French source catalogs live in `packages/i18n/messages/`.

Invitation emails open review, not acceptance. Build their links from the configured public origin and pass the stored expiry to the renderer.

The private Bun workspace exports TypeScript source, compiled by the consuming application's bundler. Use the root lockfile and pinned React version. The preview UI is a development dependency and requires no SMTP credentials.

Setup follows [React Email's workspace guide](https://react.email/docs/getting-started/monorepo-setup).
