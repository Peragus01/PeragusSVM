/** production -> live; every other deployment (staging, local) -> test. */
export function databaseEnvironmentFor(deploymentEnv) {
  return deploymentEnv === "production" ? "live" : "test";
}

/**
 * Records the single money environment of this database. Idempotent for the
 * same value; a different recorded value aborts with DATABASE_ENVIRONMENT_CONFLICT.
 */
export async function recordDatabaseEnvironment(client, deploymentEnv) {
  const environment = databaseEnvironmentFor(deploymentEnv);

  await client.query(
    `
      insert into peragus_database_environment (environment)
      values ($1)
      on conflict do nothing
    `,
    [environment],
  );

  const recorded = await client.query(
    "select environment from peragus_database_environment where singleton",
  );

  if (recorded.rows[0]?.environment !== environment) {
    throw Object.assign(new Error("DATABASE_ENVIRONMENT_CONFLICT"), {
      code: "DATABASE_ENVIRONMENT_CONFLICT",
    });
  }

  return environment;
}
