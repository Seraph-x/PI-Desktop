import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// The shell's three production column classes provide the layout inputs to
// the real body-portaled toast. No Desktop profile or model is involved.
function Surface() {
  return <I18nextProvider i18n={i18n}>
    <div className="app-shell">
      <div className="app-chat-shell">
        <aside id="sidebar" style={{ width: 320, flex: "0 0 320px" }} />
        <section className="main-pane" />
        <aside className="work-panel" style={{ "--work-panel-width": "480px", animation: "none" } as CSSProperties}>
          <button id="browser-toolbar">Browser navigation</button>
        </aside>
      </div>
      <ToastHost />
    </div>
  </I18nextProvider>;
}

declare global {
  var toastLayoutProbe: () => Promise<unknown>;
}

globalThis.toastLayoutProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  useAppStore.setState({ toasts: [] });
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(<Surface />));
  await frame();
  flushSync(() => useAppStore.getState().showToast(
    "后台会话正在等待确认：请选择接下来要修改的项目，确认后再继续执行任务。".repeat(3),
    { duration: 0, sound: false },
  ));
  await frame();
  const pane = document.querySelector<HTMLElement>(".main-pane")!;
  const sidebar = document.getElementById("sidebar")!;
  const panel = document.querySelector<HTMLElement>(".work-panel")!;
  const chat = document.querySelector<HTMLElement>(".app-chat-shell")!;
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  const stack = document.querySelector<HTMLElement>(".toast-viewport")!;
  const toast = document.querySelector<HTMLElement>(".toast")!;
  const checks: string[] = [];
  function check(label: string, target = pane) {
    const available = target.getBoundingClientRect();
    const actual = toast.getBoundingClientRect();
    assert(actual.width > 0 && actual.left >= available.left && actual.right <= available.right,
      `${label}: toast [${actual.left}, ${actual.right}] exceeds content [${available.left}, ${available.right}]`);
    assert(Math.abs((actual.left + actual.right - available.left - available.right) / 2) <= 1,
      `${label}: toast is not centered in the content pane`);
    assert(stack.parentElement?.parentElement === document.body, "Toast must remain above dialog stacking contexts");
    checks.push(label);
  }
  check("three columns");
  for (const width of [560, 360, 244, 480]) {
    panel.style.setProperty("--work-panel-width", `${width}px`);
    await frame();
    check(`panel width ${width}`);
  }
  sidebar.style.display = "none";
  await frame();
  check("collapsed sidebar");
  sidebar.style.display = "";
  sidebar.style.flexBasis = "260px";
  sidebar.style.width = "260px";
  await frame();
  check("resized sidebar");
  panel.style.display = "none";
  await frame();
  check("closed panel");
  chat.hidden = true;
  await frame();
  check("settings", shell);
  chat.hidden = false;
  pane.style.display = "none";
  await frame();
  check("maximized panel without main pane", shell);
  pane.style.display = "";
  panel.style.display = "";
  sidebar.style.display = "none";
  shell.style.width = "700px";
  await frame();
  check("narrow content pane");
  const dismiss = toast.querySelector<HTMLButtonElement>(".toast-dismiss")!;
  const hit = dismiss.getBoundingClientRect();
  assert(dismiss.contains(document.elementFromPoint(hit.x + hit.width / 2, hit.y + hit.height / 2)),
    "Dismiss must remain reachable through the body portal");
  root.unmount();
  assert(!document.querySelector(".toast-viewport"), "Unmount must remove the toast portal");
  return { ok: true, checks };
};
