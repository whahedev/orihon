export function createCommandJournal(container, options = {}) {
  if (!container || typeof container.prepend !== "function") {
    throw new TypeError("createCommandJournal(container) requires a DOM element");
  }
  const maxEntries = options.maxEntries ?? 50;
  const time = options.time ?? (() => new Date().toLocaleTimeString("ru-RU"));

  return Object.freeze({
    append(kind, title, payload) {
      const entry = document.createElement("article");
      entry.className = `log-entry ${kind}`;
      entry.dataset.logTitle = title;
      const heading = document.createElement("header");
      const label = document.createElement("span");
      const timestamp = document.createElement("span");
      const pre = document.createElement("pre");
      label.textContent = title;
      timestamp.textContent = time();
      pre.textContent = JSON.stringify(payload, null, 2);
      heading.append(label, timestamp);
      entry.append(heading, pre);
      container.prepend(entry);
      while (container.children.length > maxEntries) container.lastElementChild?.remove();
      return entry;
    },
    clear() {
      container.replaceChildren();
    },
    get size() {
      return container.children.length;
    }
  });
}

export function createPendingCommandTracker() {
  const commands = new Map();
  const fingerprint = (command) => JSON.stringify(command);

  return Object.freeze({
    mark(command, delta) {
      const key = fingerprint(command);
      const count = (commands.get(key) ?? 0) + delta;
      if (count > 0) commands.set(key, count);
      else commands.delete(key);
    },
    has(command) {
      return commands.has(fingerprint(command));
    }
  });
}
