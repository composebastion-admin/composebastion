import { query, withTransaction } from "../db/pool.js";
import { writeAuditEvent } from "./audit.js";
import { checkImageUpdatesForHost } from "./imageUpdates.js";
import { extractImagesFromCompose } from "./composeImages.js";
import {
  enqueueJobInTransaction,
  lockComposeStackForMutation,
  notifyJobQueued
} from "./jobs.js";
import { recordStackVersionInTransaction } from "./stackVersions.js";

export async function runStackUpdatePolicies() {
  const stacks = await query<any>(
    `SELECT * FROM compose_stacks
     WHERE update_policy_enabled = true
       AND status IN ('deployed', 'created')
     ORDER BY updated_at ASC`
  );

  let triggered = 0;
  for (const stack of stacks.rows) {
    const images = extractImagesFromCompose(stack.compose_yaml);
    if (images.length === 0) continue;

    await checkImageUpdatesForHost(stack.host_id);
    const scheduled = await withTransaction(async (client) => {
      const current = await lockComposeStackForMutation<any>(client, stack.id);
      if (
        !current
        || !current.update_policy_enabled
        || !["deployed", "created"].includes(String(current.status))
      ) {
        return null;
      }
      const currentImages = extractImagesFromCompose(current.compose_yaml);
      if (currentImages.length === 0) return null;
      const updates = await client.query<{ image_reference: string }>(
        `SELECT image_reference
         FROM image_update_checks
         WHERE host_id = $1
           AND image_reference = ANY($2::text[])
           AND status = 'update_available'
         ORDER BY image_reference ASC`,
        [current.host_id, currentImages]
      );
      if (updates.rows.length === 0) return null;

      await recordStackVersionInTransaction(client, {
        stackId: current.id,
        composeYaml: current.compose_yaml,
        env: current.env ?? "",
        source: "deploy",
        note: `Auto-update policy (${current.update_policy_channel ?? "digest"}) will pull ${updates.rows.length} image(s)`
      });
      const job = await enqueueJobInTransaction(client, {
        type: "compose.deploy",
        hostId: current.host_id,
        payload: {
          stackId: current.id,
          pullBeforeDeploy: true
        }
      });
      await writeAuditEvent({
        userId: null,
        hostId: current.host_id,
        action: "compose.auto_update",
        targetKind: "compose_stack",
        targetId: current.id,
        details: {
          channel: current.update_policy_channel ?? "digest",
          images: updates.rows.map((row) => row.image_reference),
          jobId: job.id
        }
      }, client);
      return { job };
    });
    if (!scheduled) continue;
    await notifyJobQueued(scheduled.job.id);
    triggered += 1;
  }

  return { checked: stacks.rows.length, triggered };
}
