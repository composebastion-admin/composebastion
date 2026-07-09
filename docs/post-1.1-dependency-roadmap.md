# Post-1.1 Dependency Compatibility Work

ComposeBastion 1.1 intentionally limits dependency changes to Node 24 support,
the reviewed action and tooling majors, and compatible application dependency
updates. The following API-breaking upgrades are deferred so they can receive
their own migration work and regression testing after 1.1:

- the next incompatible Fastify and Fastify-plugin lines, including the CORS
  and rate-limit plugin majors;
- Vite and its React plugin;
- TypeScript;
- Xterm and its add-ons;
- UUID;
- Zod; and
- the Nodemailer type definitions.

These upgrades must not be folded into a 1.1 security or maintenance update.
Before adoption, review upstream migration guides, update affected application
code and public types, run the complete unit, PostgreSQL integration, browser,
acceptance, and image-security gates, and regenerate the dependency notices.
