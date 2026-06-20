export function extractImagesFromCompose(composeYaml: string) {
  const images = new Set<string>();
  const imageLine = /^\s*image:\s*["']?([^"'\s]+)["']?\s*$/gm;
  for (const match of composeYaml.matchAll(imageLine)) {
    const image = match[1]?.trim();
    if (image && !image.startsWith("${")) images.add(image);
  }
  return Array.from(images);
}
