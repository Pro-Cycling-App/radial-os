import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "jsonc-parser";
import { generateConfigs, validateConfig } from "./deploy.mjs";

const validConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  workers: {
    workshop: { name: "acme-cloudflare-os", route: { customDomain: "os.example.com" } },
    context: { name: "acme-cloudflare-os-context" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
  },
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com"],
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: "fedcba9876543210fedcba9876543210",
    providers: ["anthropic", "cloudflare"],
    workersAi: { mode: "gateway", gateway: "cloudflare-os-workers-ai" },
  },
  context: { sharingDomain: "production", kvNamespaceId: "context-kv-id" },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

async function baseConfigs() {
  return {
    workshop: await baseConfig("../cloudflare-os/packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../cloudflare-os/packages/gatekeeper-context/wrangler.jsonc"),
    customGatekeeper: await baseConfig("../packages/custom-gatekeeper/wrangler.jsonc"),
    errorReporter: {
      name: "error-reporter",
      observability: { enabled: true, logs: { invocation_logs: false } },
    },
  };
}

async function baseConfig(path) {
  return parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("rejects deployment placeholders", () => {
  const placeholder = structuredClone(validConfig);
  placeholder.accountId = "<CLOUDFLARE_ACCOUNT_ID>";
  assert.throws(() => validateConfig(placeholder), /placeholder/i);
});

test("rejects destructive or malformed deployment values", () => {
  const duplicateWorkers = structuredClone(validConfig);
  duplicateWorkers.workers.context.name = duplicateWorkers.workers.workshop.name;
  assert.throws(() => validateConfig(duplicateWorkers), /unique/i);

  const stringBoolean = structuredClone(validConfig);
  stringBoolean.observability.enabled = "true";
  assert.throws(() => validateConfig(stringBoolean), /boolean/i);

  const invalidDomain = structuredClone(validConfig);
  invalidDomain.workers.workshop.route.customDomain = "os.example.com/path";
  assert.throws(() => validateConfig(invalidDomain), /hostname/i);

  const numericGateway = structuredClone(validConfig);
  numericGateway.aiGateway.workersAi.gateway = 42;
  assert.throws(() => validateConfig(numericGateway), /gateway name/i);

  const issuerWithPath = structuredClone(validConfig);
  issuerWithPath.access.issuer += "/team";
  assert.throws(() => validateConfig(issuerWithPath), /issuer.*origin/i);

  const blankAudience = structuredClone(validConfig);
  blankAudience.access.audience = "   ";
  assert.throws(() => validateConfig(blankAudience), /audience/i);

  const paddedAudience = structuredClone(validConfig);
  paddedAudience.access.audience = " access-audience ";
  assert.throws(() => validateConfig(paddedAudience), /audience/i);

  const malformedAdmin = structuredClone(validConfig);
  malformedAdmin.access.admins = ["bad-address"];
  assert.throws(() => validateConfig(malformedAdmin), /email/i);

  const invalidTraceSampling = structuredClone(validConfig);
  invalidTraceSampling.observability.traces.headSamplingRate = 2;
  assert.throws(() => validateConfig(invalidTraceSampling), /sampling/i);
});

test("generates Access-mode Workshop, Context, and custom Gatekeeper configs", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());

  assert.equal(generated.workshop.name, "acme-cloudflare-os");
  assert.deepEqual(generated.workshop.routes, [
    { pattern: "os.example.com", custom_domain: true },
  ]);
  assert.deepEqual(generated.workshop.vars.ADMINS, ["admin@example.com"]);
  assert.equal(generated.workshop.vars.CF_ACCESS_ISS, validConfig.access.issuer);
  assert.equal(generated.workshop.vars.CF_ACCESS_AUD, validConfig.access.audience);
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services, [
    {
      binding: "ERROR_REPORTER",
      service: "acme-cloudflare-os-errors",
      entrypoint: "ErrorReporter",
      props: { service: "acme-cloudflare-os", environment: "production", release: "abc123" },
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: "acme-cloudflare-os-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "production" },
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: "acme-cloudflare-os-custom",
      entrypoint: "GatekeeperVendor",
    },
  ]);
  assert.deepEqual(generated.workshop.assets, {
    directory: "../workshop-frontend/dist",
    not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/blueprint-screenshot/*"],
  });
  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" },
    { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.equal(generated.workshop.r2_buckets[0].bucket_name, "cloudflare-os-blueprints");
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces[0].id, "context-kv-id");
  assert.equal(generated.customGatekeeper.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper.vars, {
    CUSTOM_NAME: "Acme",
    CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter.name, "acme-cloudflare-os-errors");
  assert.deepEqual(generated.workshop.observability.logs, {
    invocation_logs: false,
  });
  assert.deepEqual(generated.workshop.observability.traces, {
    enabled: true,
    head_sampling_rate: 0.25,
  });
  assert.equal(generated.workshop.services.some(
    (service) => service.binding === "FRONTEND_ERROR_REPORTER"), false);
  assert.equal(generated.workshop.ratelimits, undefined);
});

test("omits disabled backend error reporting", async () => {
  const config = structuredClone(validConfig);
  config.errorReporting = {
    enabled: false,
    environment: "<ENVIRONMENT>",
    release: "<RELEASE>",
  };

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.errorReporter, undefined);
  assert.equal(generated.workshop.services.some(
    (service) => service.binding === "ERROR_REPORTER"), false);
});

test("omits dormant AI Gateway configuration", async () => {
  const config = structuredClone(validConfig);
  config.aiGateway = {
    enabled: false,
    name: "<AI_GATEWAY_NAME>",
    accountId: "<AI_GATEWAY_ACCOUNT_ID>",
    providers: [],
    workersAi: { mode: "gateway", gateway: "<WORKERS_AI_GATEWAY_NAME>" },
  };

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.workshop.vars.CF_AI_GATEWAY, undefined);
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_ACCOUNT_ID, undefined);
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_PROVIDERS, undefined);
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_WAI, undefined);
  assert.equal(generated.workshop.secrets, undefined);
});

test("ignores the gateway name in direct Workers AI mode", async () => {
  const config = structuredClone(validConfig);
  config.aiGateway.workersAi = { mode: "direct", gateway: "<UNUSED_GATEWAY_NAME>" };

  const generated = generateConfigs(config, await baseConfigs());

  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_WAI_DIRECT, "true");
  assert.equal(generated.workshop.vars.CF_AI_GATEWAY_WAI, undefined);
});

test("wires router gatekeepers with hyphenated slugs and vars passthrough", async () => {
  const config = structuredClone(validConfig);
  config.workers.router = { name: "acme-cloudflare-os-router" };
  config.gatekeepers = {
    mcp: { name: "acme-cloudflare-os-mcp" },
    mcp_portal: {
      name: "acme-cloudflare-os-mcp-portal",
      vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp", MCP_PORTAL_AUTH: "oauth" },
    },
  };

  const bases = await baseConfigs();
  bases.gatekeepers = {
    mcp: await baseConfig("../cloudflare-os/packages/gatekeeper-mcp/wrangler.jsonc"),
    mcp_portal: await baseConfig("../cloudflare-os/packages/gatekeeper-mcp-portal/wrangler.jsonc"),
  };
  const generated = generateConfigs(config, bases);

  // The router's binding scan lowercases and hyphenates the suffix, so BASE_URL must too.
  assert.equal(generated["gatekeeper-mcp_portal"].vars.BASE_URL,
    "https://os.example.com/gatekeeper/mcp-portal");
  assert.equal(generated["gatekeeper-mcp"].vars.BASE_URL,
    "https://os.example.com/gatekeeper/mcp");
  assert.equal(generated["gatekeeper-mcp_portal"].vars.MCP_PORTAL_URL,
    "https://portal.example.com/mcp");
  assert.equal(generated["gatekeeper-mcp_portal"].vars.MCP_PORTAL_AUTH, "oauth");
  assert.deepEqual(
    generated.workshop.services.find((s) => s.binding === "GATEKEEPER_MCP_PORTAL"),
    { binding: "GATEKEEPER_MCP_PORTAL", service: "acme-cloudflare-os-mcp-portal",
      entrypoint: "GatekeeperVendor" });
  assert.deepEqual(
    generated.router.services.find((s) => s.binding === "GATEKEEPER_MCP_PORTAL"),
    { binding: "GATEKEEPER_MCP_PORTAL", service: "acme-cloudflare-os-mcp-portal" });

  const badVars = structuredClone(config);
  badVars.gatekeepers.mcp_portal.vars = { MCP_PORTAL_URL: 42 };
  assert.throws(() => validateConfig(badVars), /vars/i);
});

test("generates binding-only storage for automatic provisioning", async () => {
  const config = structuredClone(validConfig);
  config.context.kvNamespaceId = null;
  config.resources = {
    blueprintsKvNamespaceId: null,
    avatarsKvNamespaceId: null,
    blueprintContentBucket: null,
  };

  const generated = generateConfigs(config, await baseConfigs());

  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
});
