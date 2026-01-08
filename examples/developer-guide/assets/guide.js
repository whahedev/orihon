const search = document.querySelector("[data-api-search]");
const links = [...document.querySelectorAll("[data-api-link]")];
const groups = [...document.querySelectorAll("[data-nav-group]")];
const empty = document.querySelector("[data-empty-search]");
const sidebar = document.querySelector("[data-sidebar]");
const canonical = document.body.dataset.canonicalPath;

for (const link of links) {
  if (new URL(link.href, location.href).pathname === canonical) link.setAttribute("aria-current", "page");
}

function filterNavigation() {
  const query = search?.value.trim().toLocaleLowerCase("ru") ?? "";
  let visible = 0;
  for (const link of links) {
    const match = !query || link.dataset.search.includes(query);
    link.hidden = !match;
    if (match) visible++;
  }
  for (const group of groups) {
    group.hidden = ![...group.querySelectorAll("[data-api-link]")].some((link) => !link.hidden);
  }
  if (empty) empty.hidden = visible !== 0;
}

search?.addEventListener("input", filterNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== search) {
    event.preventDefault();
    search?.focus();
  }
  if (event.key === "Escape") {
    search?.blur();
    document.body.classList.remove("nav-open");
  }
});

document.querySelector("[data-nav-toggle]")?.addEventListener("click", () => {
  document.body.classList.toggle("nav-open");
});
sidebar?.addEventListener("click", (event) => {
  if (event.target.closest("a")) document.body.classList.remove("nav-open");
});

for (const button of document.querySelectorAll("[data-copy-code]")) {
  button.addEventListener("click", async () => {
    const value = button.closest(".code")?.querySelector("code")?.textContent ?? "";
    await navigator.clipboard.writeText(value);
    const previous = button.textContent;
    button.textContent = "Скопировано";
    setTimeout(() => { button.textContent = previous; }, 1200);
  });
}

const playgrounds = [...document.querySelectorAll("[data-playground]")].map((root) => {
  const frame = root.querySelector("[data-playground-frame]");
  const editor = root.querySelector("[data-playground-code]");
  const status = root.querySelector("[data-playground-status]");
  const output = root.querySelector("[data-playground-output]");
  const initial = editor?.value ?? "";
  let ready = false;
  let probes = 0;
  let probeTimer = 0;

  const probe = () => {
    if (ready || !frame?.contentWindow || probes >= 20) {
      if (probeTimer) clearInterval(probeTimer);
      return;
    }
    probes++;
    frame.contentWindow.postMessage({ type: "orihon-playground-probe" }, "*");
  };

  const run = () => {
    if (!frame?.contentWindow || !editor) return;
    if (output) {
      output.textContent = "";
      output.hidden = true;
    }
    status.textContent = ready ? "Выполняется…" : "Карта загружается…";
    frame.contentWindow.postMessage({
      type: "orihon-playground-run",
      name: root.dataset.function,
      code: editor.value
    }, "*");
  };

  root.querySelector("[data-playground-run]")?.addEventListener("click", run);
  root.querySelector("[data-playground-reset]")?.addEventListener("click", () => {
    editor.value = initial;
    run();
  });
  editor?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      editor.setRangeText("  ", start, editor.selectionEnd, "end");
    }
  });
  frame?.addEventListener("load", () => {
    ready = false;
    probes = 0;
    probe();
  });
  probeTimer = setInterval(probe, 250);
  probe();
  return {
    root,
    frame,
    editor,
    status,
    output,
    run,
    setReady(value) {
      const changed = ready !== value;
      ready = value;
      if (ready && probeTimer) clearInterval(probeTimer);
      return changed;
    }
  };
});

window.addEventListener("message", (event) => {
  const playground = playgrounds.find((item) => item.frame?.contentWindow === event.source);
  if (!playground || !event.data?.type?.startsWith("orihon-playground-")) return;
  if (event.data.type === "orihon-playground-ready") {
    if (playground.setReady(true)) playground.run();
  } else if (event.data.type === "orihon-playground-done") {
    playground.status.textContent = "Готово · Ctrl+Enter для повторного запуска";
  } else if (event.data.type === "orihon-playground-result") {
    if (playground.output) {
      playground.output.textContent = event.data.text ?? "";
      playground.output.hidden = !event.data.text;
    }
  } else if (event.data.type === "orihon-playground-error") {
    playground.status.textContent = `Ошибка: ${event.data.message}`;
  }
});
