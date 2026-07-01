import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** Hard cap on the memory index injected into every session, in characters (~2k tokens). */
const INDEX_CHAR_CAP = 8000;

export class MemoryStore {
  private dir: string;

  constructor(root: string) {
    this.dir = join(root, "memory");
    mkdirSync(join(this.dir, "entries"), { recursive: true });
    const index = join(this.dir, "INDEX.md");
    if (!existsSync(index)) writeFileSync(index, "# Memory index\n");
  }

  /** The hot layer: injected into every agent prompt. Truncated at the cap — compaction owns keeping it small. */
  readIndex(): string {
    const text = readFileSync(join(this.dir, "INDEX.md"), "utf-8");
    return text.length > INDEX_CHAR_CAP ? text.slice(0, INDEX_CHAR_CAP) + "\n…(truncated)" : text;
  }

  readEntry(slug: string): string | null {
    const path = join(this.dir, "entries", `${slug}.md`);
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  }

  addEntry(slug: string, description: string, body: string): void {
    const safe = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
    const path = join(this.dir, "entries", `${safe}.md`);
    const isNew = !existsSync(path);
    writeFileSync(path, `# ${description}\n\n${body}\n`);
    if (isNew) appendFileSync(join(this.dir, "INDEX.md"), `- [${safe}] ${description}\n`);
  }

  entriesDir(): string {
    return join(this.dir, "entries");
  }

  indexSize(): number {
    return readFileSync(join(this.dir, "INDEX.md"), "utf-8").length;
  }

  /** Compaction should run before truncation ever kicks in. */
  needsCompaction(): boolean {
    return this.indexSize() > INDEX_CHAR_CAP * 0.8;
  }
}
