export interface OrihonEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  target: Evented;
  sourceTarget: Evented;
  propagatedFrom?: Evented;
  layer?: Evented;
  detail: T;
  [key: string]: unknown;
}

export type EventHandler<T extends OrihonEvent = OrihonEvent> = (event: T) => void;

export class Evented {
  readonly #events = new Map<string, Set<EventHandler>>();
  readonly #eventParents = new Set<Evented>();

  on<T extends OrihonEvent = OrihonEvent>(type: string, handler: EventHandler<T>): this {
    const list = this.#events.get(type);
    const normalized = handler as EventHandler;
    if (list) list.add(normalized);
    else this.#events.set(type, new Set([normalized]));
    return this;
  }

  once<T extends OrihonEvent = OrihonEvent>(type: string, handler: EventHandler<T>): this {
    const wrap: EventHandler<T> = (event) => {
      this.off(type, wrap as EventHandler);
      handler(event);
    };
    return this.on(type, wrap);
  }

  off(type?: string, handler?: EventHandler): this {
    if (!type) {
      this.#events.clear();
      return this;
    }
    const list = this.#events.get(type);
    if (!list) return this;
    if (handler) list.delete(handler);
    else list.clear();
    if (!list.size) this.#events.delete(type);
    return this;
  }

  listens(type: string, propagate = false): boolean {
    if (this.#events.get(type)?.size) return true;
    return propagate && [...this.#eventParents].some((parent) => parent.listens(type, true));
  }

  addEventParent(parent: Evented): this {
    if (parent !== this) this.#eventParents.add(parent);
    return this;
  }

  removeEventParent(parent: Evented): this {
    this.#eventParents.delete(parent);
    return this;
  }

  emit<T extends Record<string, unknown> = Record<string, unknown>>(type: string, detail = {} as T, propagate = true): this {
    const sourceTarget = detail.sourceTarget instanceof Evented ? detail.sourceTarget : this;
    const event = {
      ...detail,
      type,
      target: this,
      sourceTarget,
      detail
    } as OrihonEvent<T>;
    const list = this.#events.get(type);
    if (list) for (const handler of [...list]) handler(event);

    if (propagate) {
      for (const parent of this.#eventParents) {
        parent.emit(type, {
          ...detail,
          sourceTarget,
          propagatedFrom: this,
          layer: detail.layer instanceof Evented ? detail.layer : this
        }, true);
      }
    }
    return this;
  }
}
