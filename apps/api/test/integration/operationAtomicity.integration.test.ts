import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { createHost, createHostWithSync } from "../../src/services/hosts.js";
import { deployCatalogTemplate } from "../../src/services/catalog.js";
import { createGithubRepository, deployGithubRepository } from "../../src/services/github.js";
import { recordStackVersion, rollbackStackVersion } from "../../src/services/stackVersions.js";
import { updateApp } from "../../src/services/apps.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const prefix = "atomic-fail-";

function hostInput(name: string) {
  return {
    name,
    hostname: `${name}.invalid`,
    port: 22,
    username: "atomic-test",
    connectionMode: "ssh" as const,
    sshAuthType: "password" as const,
    sshPassword: "not-a-real-password",
    dockerSocketPath: "/var/run/docker.sock"
  };
}

describe.skipIf(!integrationEnabled)("operation domain/job atomicity", () => {
  let hostId: string;

  beforeAll(async () => {
    await runMigrations();
    await pool.query("DROP TRIGGER IF EXISTS operation_jobs_atomicity_test_trigger ON operation_jobs");
    await pool.query("DROP FUNCTION IF EXISTS operation_jobs_atomicity_test_reject()");
    await pool.query(`
      CREATE FUNCTION operation_jobs_atomicity_test_reject() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'host.sync' AND EXISTS (
          SELECT 1 FROM docker_hosts WHERE id = NEW.host_id AND name LIKE 'atomic-fail-%'
        ) THEN
          RAISE EXCEPTION 'intentional atomicity test failure';
        END IF;
        IF NEW.type = 'compose.deploy' AND EXISTS (
          SELECT 1 FROM compose_stacks
          WHERE id = (NEW.payload->>'stackId')::uuid AND project_name LIKE 'atomic-fail-%'
        ) THEN
          RAISE EXCEPTION 'intentional atomicity test failure';
        END IF;
        IF NEW.type = 'git.cloneDeploy' AND NEW.payload->>'projectName' LIKE 'atomic-fail-%' THEN
          RAISE EXCEPTION 'intentional atomicity test failure';
        END IF;
        IF NEW.type = 'compose.deployPath' AND NEW.payload->>'projectName' LIKE 'atomic-fail-%' THEN
          RAISE EXCEPTION 'intentional atomicity test failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER operation_jobs_atomicity_test_trigger
      BEFORE INSERT ON operation_jobs
      FOR EACH ROW EXECUTE FUNCTION operation_jobs_atomicity_test_reject()
    `);
    const host = await createHost(hostInput(`atomic-seed-${uuid()}`));
    hostId = host.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool.query("DROP TRIGGER IF EXISTS operation_jobs_atomicity_test_trigger ON operation_jobs");
    await pool.query("DROP FUNCTION IF EXISTS operation_jobs_atomicity_test_reject()");
    if (hostId) {
      await pool.query("DELETE FROM operation_jobs WHERE host_id = $1", [hostId]);
      await pool.query("DELETE FROM docker_hosts WHERE id = $1", [hostId]);
    }
  });

  it("rolls back host creation when its initial sync job cannot be inserted", async () => {
    const name = `${prefix}host-${uuid()}`;
    await expect(createHostWithSync(hostInput(name))).rejects.toThrow("intentional atomicity test failure");
    const hosts = await pool.query("SELECT id FROM docker_hosts WHERE name = $1", [name]);
    expect(hosts.rowCount).toBe(0);
  });

  it("rolls back catalog stack and version writes when deploy enqueue fails", async () => {
    const projectName = `${prefix}catalog-${uuid().slice(0, 8)}`;
    await expect(deployCatalogTemplate({
      templateId: "nginx",
      hostId,
      projectName,
      env: {}
    })).rejects.toThrow("intentional atomicity test failure");
    const stacks = await pool.query("SELECT id FROM compose_stacks WHERE host_id = $1 AND project_name = $2", [hostId, projectName]);
    expect(stacks.rowCount).toBe(0);
  });

  it("rolls back GitHub host-clone metadata when enqueue fails", async () => {
    const unique = uuid().slice(0, 8);
    const projectName = `${prefix}clone-${unique}`;
    const repository = await createGithubRepository({
      name: "Atomic clone",
      repositoryUrl: `https://github.com/composebastion-tests/atomic-clone-${unique}`,
      branch: "main",
      composePath: "docker-compose.yml",
      projectName,
      env: "",
      defaultHostId: hostId
    });

    await expect(deployGithubRepository(repository.id, {
      mode: "host_clone",
      hostId,
      projectName,
      hostCloneUrl: `git@github.com:composebastion-tests/atomic-clone-${unique}.git`,
      hostCloneDirectory: `/srv/${projectName}`
    })).rejects.toThrow("intentional atomicity test failure");

    const saved = await pool.query(
      "SELECT host_clone_url, host_clone_directory FROM github_repositories WHERE id = $1",
      [repository.id]
    );
    expect(saved.rows[0]).toMatchObject({ host_clone_url: null, host_clone_directory: null });
  });

  it("rolls back GitHub API stack/version writes when deploy enqueue fails", async () => {
    const unique = uuid().slice(0, 8);
    const projectName = `${prefix}github-${unique}`;
    const repository = await createGithubRepository({
      name: "Atomic API deploy",
      repositoryUrl: `https://github.com/composebastion-tests/atomic-api-${unique}`,
      branch: "main",
      composePath: "docker-compose.yml",
      projectName,
      env: "",
      defaultHostId: hostId
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })));

    await expect(deployGithubRepository(repository.id, {
      mode: "api",
      hostId,
      projectName,
      composeYaml: "services:\n  app:\n    image: nginx:alpine\n"
    })).rejects.toThrow("intentional atomicity test failure");

    const stacks = await pool.query("SELECT id FROM compose_stacks WHERE host_id = $1 AND project_name = $2", [hostId, projectName]);
    const saved = await pool.query("SELECT last_deployed_at FROM github_repositories WHERE id = $1", [repository.id]);
    expect(stacks.rowCount).toBe(0);
    expect(saved.rows[0]?.last_deployed_at).toBeNull();
    vi.unstubAllGlobals();
  });

  it("rolls back stack content and both rollback snapshots when deploy enqueue fails", async () => {
    const projectName = `${prefix}rollback-${uuid().slice(0, 8)}`;
    const stackId = uuid();
    await pool.query(
      `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env, status)
       VALUES ($1, $2, 'Atomic rollback', $3, $4, '', 'created')`,
      [stackId, hostId, projectName, "services:\n  app:\n    image: nginx:1\n"]
    );
    const first = await recordStackVersion({
      stackId,
      composeYaml: "services:\n  app:\n    image: nginx:1\n",
      env: "",
      source: "ui"
    });
    await pool.query("UPDATE compose_stacks SET compose_yaml = $2 WHERE id = $1", [stackId, "services:\n  app:\n    image: nginx:2\n"]);
    await recordStackVersion({
      stackId,
      composeYaml: "services:\n  app:\n    image: nginx:2\n",
      env: "",
      source: "ui"
    });
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM compose_stack_versions WHERE stack_id = $1", [stackId]);

    await expect(rollbackStackVersion(stackId, first.id)).rejects.toThrow("intentional atomicity test failure");

    const stack = await pool.query("SELECT compose_yaml FROM compose_stacks WHERE id = $1", [stackId]);
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM compose_stack_versions WHERE stack_id = $1", [stackId]);
    expect(stack.rows[0]?.compose_yaml).toContain("nginx:2");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("does not leave a partial first job when the second app-update insert fails", async () => {
    const projectName = `${prefix}batch-${uuid().slice(0, 8)}`;
    const stackId = uuid();
    await pool.query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status, source_type,
         source_repository_url, source_branch, source_working_dir, source_compose_path
       )
       VALUES ($1, $2, 'Atomic batch', $3, $4, '', 'deployed', 'git', $5, 'main', $6, 'docker-compose.yml')`,
      [
        stackId,
        hostId,
        projectName,
        "services:\n  app:\n    image: nginx:alpine\n",
        `https://github.com/composebastion-tests/${projectName}`,
        `/srv/${projectName}`
      ]
    );

    await expect(updateApp(`stack:${stackId}`)).rejects.toThrow("intentional atomicity test failure");
    const jobs = await pool.query(
      "SELECT type FROM operation_jobs WHERE host_id = $1 AND type IN ('git.pull', 'compose.deployPath')",
      [hostId]
    );
    expect(jobs.rowCount).toBe(0);
  });
});
