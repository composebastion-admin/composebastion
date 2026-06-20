import { useEffect, useState } from "react";
import { Download, Search } from "lucide-react";
import type { ResourceSnapshot } from "@dockermender/shared";
import { imageRepository, imageTag, imageWithTag } from "@dockermender/shared";
import { api } from "../../api.js";
import { filterImageTags, uniqueSortedImageTags } from "../../lib/imageTagOptions.js";
import { ButtonRow } from "../ui/primitives.js";

export function ContainerUpdatePanel({ container, images, onUpdate, onClose }: { container: ResourceSnapshot; images: ResourceSnapshot[]; onUpdate: (targetImage: string) => Promise<void>; onClose: () => void }) {
  const data = container.data as any;
  const currentImage = String(data.Image ?? container.name);
  const [targetImage, setTargetImage] = useState(currentImage);
  const [remoteTags, setRemoteTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState("");
  const [tagLookupState, setTagLookupState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [tagLookupError, setTagLookupError] = useState<string | null>(null);
  const repository = imageRepository(currentImage);
  const localTags = images
    .map((image) => String((image.data as any).Repository ? `${(image.data as any).Repository}:${(image.data as any).Tag ?? "latest"}` : image.name))
    .filter((image) => imageRepository(image) === repository)
    .map(imageTag)
    .filter((tag, index, all) => tag && tag !== "<none>" && all.indexOf(tag) === index)
    .sort();
  const selectedTag = imageTag(targetImage);
  const currentTag = imageTag(currentImage);
  const tags = uniqueSortedImageTags([selectedTag, currentTag], remoteTags, localTags);
  const visibleTags = filterImageTags(tags, tagFilter);

  useEffect(() => {
    setTargetImage(currentImage);
  }, [currentImage]);

  useEffect(() => {
    let cancelled = false;
    setRemoteTags([]);
    setTagLookupError(null);
    setTagLookupState("loading");

    api<{ tags: string[] }>(`/api/image-tags?image=${encodeURIComponent(currentImage)}`)
      .then((response) => {
        if (cancelled) return;
        setRemoteTags(response.tags);
        setTagLookupState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setTagLookupError(error instanceof Error ? error.message : "Registry tag lookup failed");
        setTagLookupState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [currentImage]);

  return (
    <div className="drawer">
      <div className="panelHeader">
        <h3>Update {data.Names ?? container.name}</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <div className="formHint">
        {tagLookupState === "loading" && "Looking up tags from the registry..."}
        {tagLookupState === "ready" && `Found ${remoteTags.length} registry tag${remoteTags.length === 1 ? "" : "s"} for ${repository}.`}
        {tagLookupState === "error" && `Registry tags unavailable: ${tagLookupError}. You can still enter a tag or image manually.`}
      </div>
      <div className="two">
        <input value={targetImage} onChange={(event) => setTargetImage(event.target.value)} />
        <label className="imageTagSearch">
          <Search size={15} />
          <input value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder="Filter tags" aria-label="Filter image tags" />
        </label>
      </div>
      <div className="imageTagOptions" aria-label="Image tags">
        {visibleTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`imageTagOption${tag === imageTag(targetImage) ? " selected" : ""}`}
            onClick={() => setTargetImage(imageWithTag(targetImage, tag))}
          >
            <span>{tag}</span>
            {tag === currentTag && <small>current</small>}
            {tag === selectedTag && selectedTag !== currentTag && <small>selected</small>}
          </button>
        ))}
        {visibleTags.length === 0 && <div className="notice">No tags match this filter.</div>}
      </div>
      <ButtonRow>
        <button className="primary" onClick={() => void onUpdate(targetImage)}><Download size={18} />Update To Tag</button>
      </ButtonRow>
    </div>
  );
}
