export function parseToolArgumentsArray<T>(
  argumentsText: string,
  propertyName: string
): T[] {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    const value = parsed[propertyName];
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return extractCompleteObjectsFromArray<T>(argumentsText, propertyName);
  }
}

function extractCompleteObjectsFromArray<T>(text: string, propertyName: string): T[] {
  const propertyIndex = text.indexOf(`"${propertyName}"`);
  if (propertyIndex < 0) return [];
  const arrayStart = text.indexOf("[", propertyIndex);
  if (arrayStart < 0) return [];

  const objects: T[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]" && depth === 0) break;
    if (char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
      continue;
    }
    if (char !== "}") continue;

    depth -= 1;
    if (depth !== 0 || objectStart < 0) continue;

    const objectText = text.slice(objectStart, i + 1);
    try {
      objects.push(JSON.parse(objectText) as T);
    } catch {
      // Skip only the malformed object. Earlier complete objects remain useful.
    }
    objectStart = -1;
  }

  return objects;
}
