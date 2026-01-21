import { createEl, empty, getContainer, listen } from "../dom.js";
import { Evented } from "../events.js";

export interface SuggestOptions {
  debounceMs?: number;
  minLength?: number;
  limit?: number;
}

export interface SuggestContext {
  limit?: number;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export type SuggestFetcher<TResult> = (query: string, context: SuggestContext) => Promise<TResult[] | null | undefined> | TResult[] | null | undefined;

interface Pending<TResult> {
  resolve: (value: TResult[]) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController;
}

function suggestAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("SuggestProvider was destroyed", "AbortError");
  const error = new Error("SuggestProvider was destroyed");
  error.name = "AbortError";
  return error;
}

export class SuggestProvider<TResult = unknown> {
  readonly fetcher: SuggestFetcher<TResult>;
  readonly options: Required<SuggestOptions>;
  _timer: ReturnType<typeof setTimeout> | null = null;
  _controller: AbortController | null = null;
  _pending: Pending<TResult> | null = null;
  _destroyed = false;

  constructor(fetcher: SuggestFetcher<TResult>, options: SuggestOptions = {}) {
    this.fetcher = fetcher;
    this.options = { debounceMs: 180, minLength: 2, limit: 8, ...options };
  }

  suggest(query: string, context: SuggestContext = {}): Promise<TResult[]> {
    if (this._destroyed) return Promise.reject(suggestAbortError());
    this.cancel();
    if (!query || query.trim().length < this.options.minLength) return Promise.resolve([]);
    const controller = new AbortController();
    this._controller = controller;
    return new Promise<TResult[]>((resolve, reject) => {
      const pending = { resolve, reject, controller };
      this._pending = pending;
      this._timer = setTimeout(async () => {
        this._timer = null;
        try {
          const result = await this.fetcher(query.trim(), { ...context, limit: this.options.limit, signal: controller.signal });
          resolve(result || []);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") resolve([]);
          else if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") resolve([]);
          else reject(error);
        } finally {
          if (this._pending === pending) this._pending = null;
          if (this._controller === controller) this._controller = null;
        }
      }, this.options.debounceMs);
    });
  }

  cancel(): this {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._controller?.abort();
    this._controller = null;
    this._pending?.resolve([]);
    this._pending = null;
    return this;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._controller?.abort();
    this._controller = null;
    this._pending?.reject(suggestAbortError());
    this._pending = null;
  }
}

export function createSuggestProvider<TResult>(fetcher: SuggestFetcher<TResult>, options?: SuggestOptions): SuggestProvider<TResult> {
  return new SuggestProvider(fetcher, options);
}

export interface SuggestWidgetOptions<TResult> {
  input: HTMLInputElement | string;
  list?: HTMLElement | string;
  provider: SuggestProvider<TResult>;
  label?: (item: TResult) => string;
  onSelect?: (item: TResult) => void;
  context?: (query: string) => SuggestContext;
  activeClassName?: string;
  emptyText?: string;
}

export class SuggestWidget<TResult = unknown> extends Evented {
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  readonly provider: SuggestProvider<TResult>;
  readonly label: (item: TResult) => string;
  readonly onSelect: (item: TResult) => void;
  readonly context: (query: string) => SuggestContext;
  readonly activeClassName: string;
  readonly emptyText: string;
  readonly _unsub: Array<() => void> = [];
  readonly _itemUnsub: Array<() => void> = [];
  results: TResult[] = [];
  activeIndex = -1;
  _requestId = 0;
  _destroyed = false;

  constructor(options: SuggestWidgetOptions<TResult>) {
    super();
    this.input = typeof options.input === "string"
      ? getContainer(options.input) as HTMLInputElement
      : options.input;
    this.list = options.list
      ? typeof options.list === "string"
        ? getContainer(options.list)
        : options.list
      : createEl("ul", "oh-suggest-list", this.input.parentElement ?? document.body);
    this.provider = options.provider;
    this.label = options.label ?? ((item) => String(item));
    this.onSelect = options.onSelect ?? (() => undefined);
    this.context = options.context ?? (() => ({}));
    this.activeClassName = options.activeClassName ?? "is-active";
    this.emptyText = options.emptyText ?? "";
    this.#bind();
  }

  attach(): this {
    return this.#suggest(this.input.value);
  }

  cancel(): this {
    this._requestId++;
    this.provider.cancel();
    this.results = [];
    this.activeIndex = -1;
    this.#render();
    this.emit("cancel");
    return this;
  }

  destroy(): void {
    if (this._destroyed) return;
    this.cancel();
    for (const unsubscribe of this._itemUnsub.splice(0)) unsubscribe();
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this._destroyed = true;
    this.off();
  }

  select(index = this.activeIndex): this {
    const item = this.results[index];
    if (item === undefined) return this;
    this.input.value = this.label(item);
    this.onSelect(item);
    this.emit("select", { item, index });
    this.cancel();
    return this;
  }

  #bind(): void {
    this.list.setAttribute("role", "listbox");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-expanded", "false");
    this._unsub.push(listen(this.input, "input", () => this.#suggest(this.input.value)));
    this._unsub.push(listen(this.input, "keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.#move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.#move(-1);
      } else if (event.key === "Enter") {
        if (this.activeIndex >= 0) {
          event.preventDefault();
          this.select();
        }
      }
    }));
  }

  #move(delta: number): void {
    if (!this.results.length) return;
    this.activeIndex = (this.activeIndex + delta + this.results.length) % this.results.length;
    this.#render();
  }

  #suggest(query: string): this {
    const requestId = ++this._requestId;
    this.emit("loading", { query });
    void this.provider.suggest(query, this.context(query)).then((items) => {
      if (this._destroyed || requestId !== this._requestId) return;
      this.results = items;
      this.activeIndex = items.length ? 0 : -1;
      this.#render();
      this.emit("results", { query, items });
    }).catch((error) => {
      if (this._destroyed || requestId !== this._requestId) return;
      this.results = [];
      this.activeIndex = -1;
      this.#render();
      this.emit("error", { query, error });
    });
    return this;
  }

  #render(): void {
    for (const unsubscribe of this._itemUnsub.splice(0)) unsubscribe();
    empty(this.list);
    this.input.setAttribute("aria-expanded", String(this.results.length > 0));
    if (!this.results.length && this.emptyText) {
      const item = createEl("li", "oh-suggest-empty", this.list);
      item.textContent = this.emptyText;
      return;
    }
    for (let index = 0; index < this.results.length; index++) {
      const result = this.results[index];
      const item = createEl("li", "oh-suggest-item", this.list);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.activeIndex));
      if (index === this.activeIndex) item.classList.add(this.activeClassName);
      const button = createEl("button", "oh-suggest-button", item);
      button.type = "button";
      button.textContent = this.label(result);
      this._itemUnsub.push(listen(button, "click", () => this.select(index)));
    }
  }
}

export function createSuggestWidget<TResult>(options: SuggestWidgetOptions<TResult>): SuggestWidget<TResult> {
  return new SuggestWidget(options);
}
