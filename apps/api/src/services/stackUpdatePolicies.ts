import { query } from "../db/pool.js";
import { enqueueJob } from "./jobs.js";
import { checkImageUpdatesForHost } from "./imageUpdates.js";
import { extractImagesFromCompose } from "./composeImages.js";
import { recordStackVersion } from "./stackVersions.js";

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
    const updates = await query<any>(
      `SELECT image_reference
       FROM image_update_checks
       WHERE host_id = $1
         AND image_reference = ANY($2::text[])
         AND status = 'update_available'`,
      [stack.host_id, images]
    );
    if (updates.rows.length === 0) continue;

    for (const row of updates.rows) {
      await enqueueJob({
        type: "image.pull",
        hostId: stack.host_id,
        payload: { image: row.image_reference }
      });
    }

    await recordStackVersion({
      stackId: stack.id,
      composeYaml: stack.compose_yaml,
      env: stack.env ?? "",
      source: "deploy",
      note: `Auto-update policy (${stack.update_policy_channel ?? "digest"}) pulled ${updates.rows.length} image(s)`
    });
    await enqueueJob({
      type: "compose.deploy",
      hostId: stack.host_id,
      payload: { stackId: stack.id }
    });
    triggered += 1;
  }

  return { checked: stacks.rows.length, triggered };
}
