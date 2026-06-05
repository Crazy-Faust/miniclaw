import { z } from "zod";
import { ok, fail, type Skill } from "@miniclaw/core";
import type { CanvasStore } from "./store.ts";

export interface CanvasSkillOpts {
  store: CanvasStore;
  /**
   * Base URL the user can open in a browser to view a canvas. The skills
   * compose URLs as `${baseUrl}/canvas/<id>` — pass the externally-
   * reachable origin of the gateway's HTTP server. Defaults to
   * "http://localhost:3000" so unconfigured installs still produce
   * usable output.
   */
  baseUrl?: string;
}

export function createCanvasSkills(opts: CanvasSkillOpts): Skill<unknown>[] {
  const base = (opts.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const store = opts.store;

  const CreateParams = z.object({
    title: z.string().min(1).max(120),
    html: z
      .string()
      .min(1)
      .describe("HTML body fragment. The page chrome (<head>, styles) is added by the server."),
  });
  const create: Skill<z.infer<typeof CreateParams>> = {
    name: "canvas_create",
    description:
      "Create a new HTML scratchpad page the user can open in a browser. " +
      "Pass a title and an HTML body fragment; the server adds page chrome. " +
      "Returns the URL.",
    parameters: CreateParams,
    execute(args) {
      const rec = store.create(args.title, args.html);
      return ok(`created ${rec.id} — open ${base}/canvas/${rec.id}`);
    },
  };

  const UpdateParams = z.object({
    id: z.string().min(1),
    html: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
  });
  const update: Skill<z.infer<typeof UpdateParams>> = {
    name: "canvas_update",
    description: "Replace the body of an existing canvas (and optionally retitle it).",
    parameters: UpdateParams,
    execute(args) {
      const rec = store.update(args.id, args.html, args.title);
      if (!rec) return fail(`unknown canvas: ${args.id}`);
      return ok(`updated ${rec.id}`);
    },
  };

  const list: Skill<Record<string, never>> = {
    name: "canvas_list",
    description: "List existing canvases with their URLs.",
    parameters: z.object({}),
    execute() {
      const rows = store.list();
      if (rows.length === 0) return ok("(no canvases)");
      return ok(
        rows
          .map((r) => `${r.id} — ${r.title}  (${base}/canvas/${r.id})`)
          .join("\n"),
      );
    },
  };

  const DeleteParams = z.object({ id: z.string().min(1) });
  const del: Skill<z.infer<typeof DeleteParams>> = {
    name: "canvas_delete",
    description: "Delete a canvas by id. No-ops if the id is unknown.",
    parameters: DeleteParams,
    execute(args) {
      const ok_ = store.delete(args.id);
      return ok(ok_ ? `deleted ${args.id}` : `(no canvas ${args.id})`);
    },
  };

  return [create, update, list, del] as Skill<unknown>[];
}
