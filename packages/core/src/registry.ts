import type { ToolSpec } from "./llm.ts";
import type { Skill } from "./skill.ts";
import { toolSpecFromSkill } from "./skill.ts";

export class SkillRegistry {
  private readonly skills = new Map<string, Skill<unknown>>();

  register(skill: Skill<unknown>): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`skill already registered: ${skill.name}`);
    }
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill<unknown> {
    const s = this.skills.get(name);
    if (!s) throw new Error(`unknown skill: ${name}`);
    return s;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  list(): Skill<unknown>[] {
    return [...this.skills.values()];
  }

  toolSpecs(): ToolSpec[] {
    return this.list().map(toolSpecFromSkill);
  }
}
