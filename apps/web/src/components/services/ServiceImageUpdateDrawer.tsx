import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search, X } from "lucide-react";
import type { ResourceSnapshot } from "@composebastion/shared";
import { imageRepository, imageTag, imageWithTag } from "@composebastion/shared";
import { api } from "../../api.js";
import { filterImageTags, uniqueSortedImageTags } from "../../lib/imageTagOptions.js";
import type { ServiceGroup, ServiceMember } from "../../lib/serviceGroups.js";
import { ButtonRow } from "../ui/primitives.js";

type ImageFamily = {
  repository: string;
  members: ServiceMember[];
  currentTags: string[];
  representativeImage: string;
  localTags: string[];
};

export type ServiceImageUpdateTarget = {
  containerId: string;
  containerName: string;
  targetImage: string;
};

function imageReferenceFromResource(resource: ResourceSnapshot) {
  const data = resource.data as Record<string, unknown>;
  if (data.Repository) return `${String(data.Repository)}:${String(data.Tag ?? "latest")}`;
  return resource.name;
}

function buildFamilies(group: ServiceGroup, images: ResourceSnapshot[]): ImageFamily[] {
  const byRepository = new Map<string, ImageFamily>();
  for (const member of group.members) {
    if (!member.image) continue;
    const repository = imageRepository(member.image);
    const family = byRepository.get(repository) ?? {
      repository,
      members: [],
      currentTags: [],
      representativeImage: member.image,
      localTags: []
    };
    family.members.push(member);
    family.currentTags.push(imageTag(member.image));
    byRepository.set(repository, family);
  }

  for (const family of byRepository.values()) {
    family.currentTags = uniqueSortedImageTags(family.currentTags);
    family.localTags = uniqueSortedImageTags(
      images
        .filter((image) => image.hostId === group.hostId)
        .map(imageReferenceFromResource)
        .filter((reference) => imageRepository(reference) === family.repository)
        .map(imageTag)
    );
  }

  return Array.from(byRepository.values()).sort((left, right) => left.repository.localeCompare(right.repository));
}

export function ServiceImageUpdateDrawer({
  group,
  images,
  busy,
  onClose,
  onUpdate
}: {
  group: ServiceGroup;
  images: ResourceSnapshot[];
  busy: boolean;
  onClose: () => void;
  onUpdate: (targets: ServiceImageUpdateTarget[]) => Promise<void>;
}) {
  const families = useMemo(() => buildFamilies(group, images), [group, images]);
  const [targetTags, setTargetTags] = useState<Record<string, string>>({});
  const [remoteTags, setRemoteTags] = useState<Record<string, string[]>>({});
  const [tagFilters, setTagFilters] = useState<Record<string, string>>({});
  const [loadingRepositories, setLoadingRepositories] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setTargetTags(Object.fromEntries(families.map((family) => [family.repository, family.currentTags[0] ?? "latest"])));
  }, [families]);

  useEffect(() => {
    let cancelled = false;
    setRemoteTags({});
    setErrors({});
    setLoadingRepositories(new Set(families.map((family) => family.repository)));

    for (const family of families) {
      void api<{ tags: string[] }>(`/api/image-tags?image=${encodeURIComponent(family.representativeImage)}`)
        .then((response) => {
          if (cancelled) return;
          setRemoteTags((current) => ({ ...current, [family.repository]: response.tags }));
        })
        .catch((caught) => {
          if (cancelled) return;
          setErrors((current) => ({
            ...current,
            [family.repository]: caught instanceof Error ? caught.message : String(caught)
          }));
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingRepositories((current) => {
            const next = new Set(current);
            next.delete(family.repository);
            return next;
          });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [families]);

  const targets = families.flatMap((family) => {
    const tag = targetTags[family.repository] ?? family.currentTags[0] ?? "latest";
    return family.members.map((member) => ({
      containerId: member.externalId,
      containerName: member.containerName,
      targetImage: imageWithTag(member.image, tag)
    }));
  });
  const changedTargets = targets.filter((target) => {
    const member = group.members.find((item) => item.externalId === target.containerId);
    return member ? target.targetImage !== member.image : true;
  });

  return (
    <div className="drawer serviceImageUpdateDrawer" role="dialog" aria-modal="true" aria-label={`Update images for ${group.name}`}>
      <div className="panelHeader">
        <div>
          <h3>Update {group.name} images</h3>
          <p>{group.members.length} container{group.members.length === 1 ? "" : "s"} across {families.length} image repositor{families.length === 1 ? "y" : "ies"}</p>
        </div>
        <button type="button" onClick={onClose} title="Close"><X size={16} /></button>
      </div>

      <div className="notice warning">
        This updates every selected running container in the service together. For Git-backed Compose stacks, prefer the GitHub version selector when you want source and compose files to move together.
      </div>

      <div className="serviceImageFamilies">
        {families.map((family) => {
          const selectedTag = targetTags[family.repository] ?? family.currentTags[0] ?? "latest";
          const allTags = uniqueSortedImageTags([selectedTag], family.currentTags, remoteTags[family.repository] ?? [], family.localTags);
          const visibleTags = filterImageTags(allTags, tagFilters[family.repository] ?? "");
          const loading = loadingRepositories.has(family.repository);
          return (
            <section key={family.repository} className="serviceImageFamily">
              <div className="serviceImageFamilyHeader">
                <div>
                  <strong>{family.repository}</strong>
                  <small>{family.members.map((member) => member.serviceName).join(", ")}</small>
                </div>
                <span>{loading ? <RefreshCw className="spin" size={14} /> : `${allTags.length} tags`}</span>
              </div>
              {errors[family.repository] && <div className="notice error">{errors[family.repository]}</div>}
              <input
                className="serviceImageTarget"
                value={imageWithTag(family.representativeImage, selectedTag)}
                onChange={(event) => setTargetTags((current) => ({ ...current, [family.repository]: imageTag(event.target.value) }))}
                aria-label={`Target image for ${family.repository}`}
              />
              <label className="imageTagSearch">
                <Search size={15} />
                <input
                  value={tagFilters[family.repository] ?? ""}
                  onChange={(event) => setTagFilters((current) => ({ ...current, [family.repository]: event.target.value }))}
                  placeholder="Filter tags"
                  aria-label={`Filter tags for ${family.repository}`}
                />
              </label>
              <div className="imageTagOptions" aria-label={`Tags for ${family.repository}`}>
                {visibleTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`imageTagOption${tag === selectedTag ? " selected" : ""}`}
                    onClick={() => setTargetTags((current) => ({ ...current, [family.repository]: tag }))}
                  >
                    <span>{tag}</span>
                    {family.currentTags.includes(tag) && <small>current</small>}
                    {tag === selectedTag && !family.currentTags.includes(tag) && <small>selected</small>}
                  </button>
                ))}
                {visibleTags.length === 0 && <div className="notice">No tags match this filter.</div>}
              </div>
            </section>
          );
        })}
      </div>

      <ButtonRow>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy || changedTargets.length === 0} onClick={() => void onUpdate(changedTargets)}>
          <Download size={16} />
          Update {changedTargets.length} container{changedTargets.length === 1 ? "" : "s"}
        </button>
      </ButtonRow>
    </div>
  );
}
