import { networkDriverExplanations, type NetworkDriver } from "@composebastion/shared";
import { Panel } from "../ui/primitives.js";

export function LearnPanel() {
  const entries = Object.entries(networkDriverExplanations) as Array<[NetworkDriver, (typeof networkDriverExplanations)[NetworkDriver]]>;
  const workflows = [
    {
      title: "Compose Deploys",
      points: [
        "Preview pulls the Compose file from the selected branch before anything is deployed.",
        "Deploy Customized sends the edited YAML and .env text to the server, stores it as a Compose stack, then runs docker compose up.",
        "Compose variable override fields are generated from placeholders such as ${APP_PORT:-3000}, ${IMAGE_TAG-latest}, or ${SECRET_KEY}; use those fields to write .env values before deploy.",
        "Project names must be lowercase. Use one project name per app so Compose can update the same stack safely.",
        "Deploy now force-recreates services so port, env, and image edits are applied to existing containers."
      ]
    },
    {
      title: "Host Inventory",
      points: [
        "All hosts combines inventory from every server so Dashboard, Services, Containers, Images, and Updates can show one working view.",
        "Selecting a host narrows container and image actions to that server.",
        "Selected hosts lets you compare or operate on a smaller fleet without changing each host one by one.",
        "Manual host checks and inventory refresh are available from the Hosts page when you need them."
      ]
    },
    {
      title: "Services And Source Tracking",
      points: [
        "Services groups Compose projects and standalone containers into the operational view you use day to day.",
        "Current and latest versions come from existing git commit checks or image digest checks.",
        "Standalone containers can be linked to an image tag, Compose folder, or Git folder so ComposeBastion knows how to check and update them.",
        "Private GitHub repositories are supported from Deploy -> Tracked GitHub repositories by adding a fine-grained token with read-only Contents access.",
        "The old Apps information now lives in Services so source, status, versions, ports, and lifecycle actions stay together."
      ]
    },
    {
      title: "Ports",
      points: [
        "In Compose, the left side is the host port and the right side is the container port: 3100:3000 exposes the app at host:3100.",
        "If a port line uses ${APP_PORT:-3000}:3000, the public port comes from APP_PORT in .env. Changing an environment variable named PORT inside the service may only change the app process.",
        "After a deploy, ComposeBastion refreshes inventory automatically. Use the host refresh action only if Docker changed outside the app and the table still looks stale."
      ]
    },
    {
      title: "Backups",
      points: [
        "Container backup only backs up named Docker volumes attached to that container.",
        "Bind mounts like /home/user/app:/config are host folders, not named Docker volumes, so they are skipped.",
        "Use Recovery -> Backups when you need to back up or restore a named volume directly.",
        "Backup files are stored in the ComposeBastion backup volume under /data/backups.",
        "Scheduled backups live under Recovery -> Schedules on a minimum five-minute interval."
      ]
    },
    {
      title: "Recovery And Migration",
      points: [
        "Recovery Points are app-level restore anchors for moving or restoring services.",
        "Migrate App plans host-to-host moves and clones before running restore jobs.",
        "Advanced direct clone tools are available in Migrate App when you already know the source container or volume.",
        "Restore / Migration Runs records the recent recovery jobs so you can check outcomes after a move."
      ]
    },
    {
      title: "Images And Updates",
      points: [
        "Dangling or untagged <none> image layers are hidden by default because they are usually old build layers or orphaned image remnants.",
        "Use Show dangling when you need to inspect those entries; use Prune dangling for Docker's dangling-layer cleanup or Clean unused for a review-first tagged image cleanup.",
        "Pull Image only downloads image layers to the selected host; it does not create or start a container.",
        "Run Image opens the container configuration form so you can choose ports, environment variables, volumes, network, restart policy, and command before starting.",
        "Update To Tag pulls the target image, recreates the container from its current definition, and starts it again if it was running.",
        "The chosen tag must exist in the registry and the host must be logged in when the registry is private.",
        "Favorites are shortcuts for images you deploy often; they do not pin or mirror registry content."
      ]
    },
    {
      title: "Catalog",
      points: [
        "Catalog includes built-in templates, saved custom templates, and external discovery from Awesome-Selfhosted.",
        "External discovery lists popular self-hosted apps by stars and imports them as draft templates, not as one-click deployments.",
        "Custom templates need a lowercase ID, short description, Compose YAML, optional .env defaults, suggested ports, and suggested volumes.",
        "For third-party projects, replace the draft image with the official image or Compose example from the project docs, then check image tags, secrets, host paths, and ports before saving.",
        "Review every Compose file and environment value before deployment, especially secrets and host paths.",
        "After a catalog deploy, the stack appears in Services and Compose for ongoing update, redeploy, and recovery workflows."
      ]
    },
    {
      title: "SSH Terminal",
      points: [
        "SSH opens as a near full-screen audited terminal so host-level repair work has enough room.",
        "The SSH page is the canonical place for host shell sessions; recovery no longer duplicates that terminal launcher.",
        "Terminal access is owner/admin only because it can run privileged host commands."
      ]
    },
    {
      title: "Connection Reliability",
      points: [
        "SSH is simple and agentless, but every action opens a fresh SSH session and can time out on slow hosts or flaky links.",
        "Agent mode is the v0.9 path for always-connected hosts: one small service on each Docker server keeps heartbeats, streams logs/stats, and runs queued work locally.",
        "Keep the app and agent images on the same release when possible so host metrics, logs, file actions, and queued Docker work stay in parity.",
        "Keep SSH as the fallback because it is easy to bootstrap new hosts and repair the agent when needed."
      ]
    }
  ];

  return (
    <div className="learnStack">
      <Panel title="Operator Guide">
        <div className="guideGrid">
          {workflows.map((item) => (
            <article className="guideItem" key={item.title}>
              <strong>{item.title}</strong>
              <ul className="guideList">
                {item.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="Docker Network Guide">
        <div className="guideGrid">
          {entries.map(([key, item]) => (
            <article className="guideItem" key={key}>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              <span>{item.bestFor}</span>
              <small>{item.watchOut}</small>
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}
