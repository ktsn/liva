import { resolve } from "@liva/runtime";
import type { Edit } from "./protocol.ts";
import type { EditorController } from "./controller.ts";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountEditor(controller: EditorController) {
  const host = element("div");
  host.dataset.livaEditor = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = element("style");
  style.textContent = `:host{position:fixed;right:20px;bottom:20px;z-index:2147483646;font:12px/1.5 system-ui;color:#244238}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #bacbbb;border-radius:6px;padding:7px 10px;background:#f5f8f0;color:#244238}button:hover{background:#e5eddf}input,select,textarea{width:100%;border:1px solid #cbd6c7;border-radius:5px;background:#fff;padding:7px;color:#244238}textarea{min-height:65px;resize:vertical}label{display:block;margin:10px 0 4px;font-size:11px;color:#627568}h2{font-size:16px;margin:0}h3{font-size:12px;margin:16px 0 6px}p{margin:8px 0;color:#627568}.launcher{background:#244e3a;color:white;border:0;border-radius:30px;padding:12px 20px;box-shadow:0 4px 24px #0002}.panel{width:min(440px,calc(100vw - 32px));max-height:82vh;background:#fffefa;border:1px solid #cbd6c7;border-radius:12px;box-shadow:0 12px 60px #152c3030;overflow:auto;padding:20px;margin-bottom:10px}.top,.actions{display:flex;gap:8px;align-items:center;justify-content:space-between}.actions{position:sticky;bottom:-20px;background:#fffefa;padding:14px 0;margin-top:12px;border-top:1px solid #dce3d7}details{border-top:1px solid #e2e8dc;margin-top:12px;padding-top:10px}summary{cursor:pointer;font-weight:600}.field{border-left:2px solid #d4dfca;padding-left:10px}.status{white-space:pre-wrap;background:#edf3e8;padding:10px;border-radius:6px;margin-top:12px;font-size:11px}.origin{font-size:10px;color:#75856c}pre{white-space:pre-wrap;word-break:break-word;font:10px/1.6 ui-monospace,monospace;max-height:180px;overflow:auto}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #b87043;outline-offset:2px}`;
  const launcher = element("button", "Motion editor");
  launcher.className = "launcher";
  const panel = element("section");
  panel.className = "panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Liva motion editor");
  const top = element("div");
  top.className = "top";
  top.append(element("h2", "Motion editor"));
  const close = element("button", "Close");
  close.onclick = () => {
    panel.hidden = true;
  };
  top.append(close);
  const instances = element("select");
  instances.setAttribute("aria-label", "Preview instance");
  const content = element("div");
  const status = element("div");
  status.className = "status";
  status.setAttribute("role", "status");
  panel.append(
    top,
    element("p", "Preview one instance. Save the shared definition."),
    instances,
    content,
    status,
  );
  shadow.append(style, panel, launcher);
  document.body.append(host);
  let renderedInspection: unknown;
  let rendering = false;
  let destination = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (operation: () => Promise<void>) => {
    void operation().catch((error) => controller.report(error));
  };

  const draft = (edit: Edit, key?: string) => {
    const edits = controller.draft.filter(
      (existing) => !(key && existing.op === "set" && existing.path === key),
    );
    edits.push(edit);
    // Value edits use the old frame identity; offsets move that identity last.
    edits.sort(
      (a, b) =>
        Number(a.op === "set" && a.path.endsWith("/offset")) -
        Number(b.op === "set" && b.path.endsWith("/offset")),
    );
    controller.setDraft(edits);
    clearTimeout(timer);
    timer = setTimeout(() => run(() => controller.preview(destination)), 250);
  };

  const select = (label: string, values: { value: string; text?: string }[]) => {
    const node = element("select");
    node.setAttribute("aria-label", label);
    values.forEach(({ value, text }) => {
      const option = element("option", text ?? value);
      option.value = value;
      node.append(option);
    });
    return node;
  };
  const input = (parent: HTMLElement, label: string, value: string, multiline = false) => {
    const wrapper = element("label", label);
    const field = multiline ? element("textarea") : element("input");
    field.value = value;
    wrapper.append(field);
    parent.append(wrapper);
    return field;
  };

  const renderContent = () => {
    content.replaceChildren();
    const inspection = controller.inspection;
    if (!inspection) return;
    const definition = inspection.definition;
    const states = definition.states.map((state) => ({ value: state.name }));
    const state = select("Preview destination", states);
    destination =
      definition.states.find((s) => s.name !== controller.selected?.binding.requestedState)?.name ??
      states[0].value;
    state.value = destination;
    state.onchange = () => {
      destination = state.value;
      showInheritance();
    };
    content.append(element("label", "Preview destination"), state);
    const inheritance = element("pre");
    inheritance.className = "origin";
    const showInheritance = () => {
      const from = controller.selected?.binding.requestedState ?? states[0].value;
      try {
        const tracks = resolve(definition, from, destination);
        const direction = definition.directionalTransitions.find(
          (d) => d.from === from && d.to === destination,
        )?.transition;
        inheritance.textContent = tracks
          .map((track) => {
            const local = direction?.targets
              .find((t) => t.name === track.target)
              ?.properties.find((p) => p.name === track.property);
            const general = definition.generalTransition?.targets
              .find((t) => t.name === track.target)
              ?.properties.find((p) => p.name === track.property);
            const origin = local?.timing
              ? "local property"
              : general?.timing
                ? "inherited general property"
                : direction?.timing
                  ? "local transition"
                  : "inherited general transition";
            return `${track.target}.${track.property} · ${track.timing.kind}\n  ${origin}${local?.keyframes ? " · local frames" : general?.keyframes ? " · inherited frames" : ""}`;
          })
          .join("\n");
      } catch (error) {
        inheritance.textContent = String(error);
      }
    };
    showInheritance();
    content.append(inheritance);
    const statesDetails = element("details");
    statesDetails.append(element("summary", "States"));
    const stateText = element("pre", JSON.stringify(definition.states, null, 2));
    statesDetails.append(stateText);
    content.append(statesDetails);

    const fields = inspection.fields.filter(
      (f) => f.kind === "value" && f.path.includes("/transition/"),
    );
    const groups = new Map<string, HTMLElement>();
    for (const field of fields) {
      const rest = field.path.split("/transition/")[1];
      const segments = rest.split("/");
      const direction =
        segments[0] === "general"
          ? "General · shared by all directions"
          : `${segments[1]} → ${segments[2]} · local overrides`;
      let group = groups.get(direction);
      if (!group) {
        const details = element("details");
        details.open = true;
        details.append(element("summary", direction));
        group = element("div");
        details.append(group);
        content.append(details);
        groups.set(direction, group);
      }
      const fullTiming = field.path.endsWith("/timing");
      const label = rest
        .replace(/^general\//, "")
        .replace(/^directional\/[^/]+\/[^/]+\//, "")
        .replace(/target\/|property\//g, "")
        .replaceAll("/", " · ");
      const wrapper = element("div");
      wrapper.className = "field";
      const fieldInput = input(
        wrapper,
        fullTiming ? `${label} (expression / change mode)` : label,
        field.value,
        fullTiming,
      );
      fieldInput.dataset.path = field.path;
      fieldInput.onchange = () => {
        if (fullTiming) {
          for (const child of content.querySelectorAll<HTMLInputElement>("[data-path]")) {
            if (child.dataset.path?.startsWith(`${field.path}/`)) child.disabled = true;
          }
          controller.setDraft(
            controller.draft.filter((e) => e.op !== "set" || !e.path.startsWith(`${field.path}/`)),
          );
        } else if (field.path.includes("/timing/")) {
          const timingPath = field.path.slice(0, field.path.indexOf("/timing/") + 7);
          controller.setDraft(
            controller.draft.filter((e) => e.op !== "set" || e.path !== timingPath),
          );
        }
        draft({ op: "set", path: field.path, value: fieldInput.value }, field.path);
      };
      if (field.path.endsWith("/timing/duration")) {
        const slider = element("input");
        slider.dataset.path = field.path;
        slider.type = "range";
        slider.min = "1";
        slider.max = "2000";
        slider.step = "1";
        slider.setAttribute("aria-label", label + " slider");
        slider.value = String(parseFloat(field.value) * (field.value.endsWith("ms") ? 1 : 1000));
        slider.oninput = () => {
          fieldInput.value = slider.value + "ms";
          fieldInput.dispatchEvent(new Event("change"));
        };
        wrapper.append(slider);
      }
      group.append(wrapper);
    }

    const frames = element("details");
    frames.append(element("summary", "Add or remove a keyframe"));
    const tracks = inspection.fields.filter(
      (f) => f.kind === "block" && f.path.includes("/property/") && !f.path.includes("/frame/"),
    );
    const trackSelect = select(
      "Frame track",
      tracks.map((f) => ({
        value: f.path,
        text: f.path.replace(`${definition.name}/transition/`, "").replaceAll("/", " · "),
      })),
    );
    frames.append(trackSelect);
    const offset = input(frames, "New frame offset (%)", "50");
    const value = input(frames, "New frame value", "1.1");
    const easing = input(frames, "New frame easing (optional)", "");
    const add = element("button", "Add frame to draft");
    add.onclick = () =>
      draft({
        op: "addFrame",
        path: trackSelect.value,
        offset: Number(offset.value) / 100,
        value: value.value,
        ...(easing.value ? { easing: easing.value } : {}),
      });
    frames.append(add);
    for (const frame of inspection.fields.filter(
      (f) => f.kind === "block" && /\/frame\/[^/]+$/.test(f.path),
    )) {
      const remove = element("button", `Remove ${frame.path.split("/frame/")[1]} frame`);
      remove.title = frame.path;
      remove.onclick = () => {
        for (const child of content.querySelectorAll<HTMLInputElement>("[data-path]")) {
          if (child.dataset.path?.startsWith(`${frame.path}/`)) child.disabled = true;
        }
        controller.setDraft(
          controller.draft.filter((e) => e.op !== "set" || !e.path.startsWith(`${frame.path}/`)),
        );
        draft({ op: "removeFrame", path: frame.path });
        remove.disabled = true;
      };
      frames.append(remove);
    }
    content.append(frames);

    const override = element("details");
    override.append(element("summary", "Create a directional timing override"));
    const from = select("Override from state", states);
    const to = select("Override to state", states);
    to.value = states[1]?.value ?? states[0].value;
    const pairs = definition.states[0].targets.flatMap((t) =>
      t.properties.map((p) => ({ value: `${t.name}/${p.name}`, text: `${t.name}.${p.name}` })),
    );
    const property = select("Override property", pairs);
    override.append(
      element("label", "From"),
      from,
      element("label", "To"),
      to,
      element("label", "Property"),
      property,
    );
    const timing = input(
      override,
      "Override timing",
      "tween(duration: 350ms, easing: ease-out)",
      true,
    );
    const addOverride = element("button", "Add override to draft");
    addOverride.onclick = () => {
      const [target, name] = property.value.split("/");
      draft({
        op: "override",
        definition: definition.name,
        from: from.value,
        to: to.value,
        target,
        property: name,
        timing: timing.value,
      });
    };
    override.append(addOverride);
    content.append(override);

    const actions = element("div");
    actions.className = "actions";
    const preview = element("button", "Preview");
    preview.onclick = () => {
      clearTimeout(timer);
      run(() => controller.preview(destination));
    };
    const cancel = element("button", "Cancel draft");
    cancel.onclick = () => {
      clearTimeout(timer);
      run(() => controller.cancel());
    };
    const save = element("button", "Save to source");
    save.onclick = () => {
      clearTimeout(timer);
      run(() => controller.commit());
    };
    actions.append(preview, cancel, save);
    content.append(actions);
  };

  const update = () => {
    if (rendering) return;
    rendering = true;
    instances.replaceChildren();
    const placeholder = element("option", "Choose an instance…");
    placeholder.value = "";
    instances.append(placeholder);
    for (const entry of controller.entries.values()) {
      const option = element("option", `${entry.label} · ${entry.binding.definition.name}`);
      option.value = entry.id;
      instances.append(option);
    }
    instances.value = controller.selected?.id ?? "";
    status.textContent = controller.message;
    if (renderedInspection !== controller.inspection) {
      renderedInspection = controller.inspection;
      renderContent();
    }
    rendering = false;
  };
  controller.subscribe(update);
  instances.onchange = () => {
    clearTimeout(timer);
    run(() => controller.select(instances.value));
  };
  launcher.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!controller.selected && controller.entries.size)
      run(() => controller.select(controller.entries.keys().next().value!));
  };
  update();
  import.meta.hot?.dispose(() => {
    clearTimeout(timer);
    host.remove();
  });
}
