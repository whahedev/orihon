interface EventMetadata<TType extends string, TTarget> {
  type: TType;
  target: TTarget;
  sourceTarget: Evented<any>;
  propagatedFrom?: Evented<any>;
  layer?: Evented<any>;
}

/** Flat event object: payload fields live on the event itself (e.g. `event.latlng`). */
export type OrihonEvent<T extends object = Record<string, unknown>, TType extends string = string, TTarget = Evented<any>> =
  T extends unknown
    ? Omit<T, "type" | "target" | "sourceTarget" | "detail"> &
      EventMetadata<TType, TTarget> &
      Record<string, unknown>
    : never;

/** Known literal names infer their payload; dynamic/custom names retain unknown fields. */
export type EventFor<TEvents extends object, TName extends string, TTarget = Evented<any>> =
  string extends TName ? OrihonEvent<Record<string, unknown>, TName, TTarget> : TName extends keyof TEvents
    ? OrihonEvent<TEvents[TName] & object, TName, TTarget>
    : OrihonEvent<Record<string, unknown>, TName, TTarget>;

export type EventHandler<T extends { type: string } = OrihonEvent> = (event: T) => void;

export class Evented<TEvents extends object = {}> {
  readonly #events = new Map<string, Set<EventHandler>>();
  readonly #eventParents = new Set<Evented<any>>();

  on<K extends string>(type: K, handler: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this {
    const list = this.#events.get(type);
    const normalized = handler as unknown as EventHandler;
    if (list) list.add(normalized);
    else this.#events.set(type, new Set([normalized]));
    return this;
  }

  once<K extends string>(type: K, handler: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this {
    const wrap: EventHandler<EventFor<TEvents, K, this>> = (event) => {
      this.off(type, wrap);
      handler(event);
    };
    return this.on(type, wrap);
  }

  off(): this;
  off<K extends string>(type: K, handler?: EventHandler<EventFor<TEvents, NoInfer<K>, this>>): this;
  off(type?: string, handler?: EventHandler<any>): this {
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

  addEventParent(parent: Evented<any>): this {
    if (parent !== this) this.#eventParents.add(parent);
    return this;
  }

  removeEventParent(parent: Evented<any>): this {
    this.#eventParents.delete(parent);
    return this;
  }

  emit<T extends Record<string, unknown> = Record<string, unknown>>(type: string, payload = {} as T, propagate = true): this {
    const sourceTarget = payload.sourceTarget instanceof Evented ? payload.sourceTarget : this;
    const event = {
      ...payload,
      type,
      target: this,
      sourceTarget
    } as unknown as OrihonEvent<T> & { detail?: unknown };
    // Drop any accidental `detail` key — payloads are flat only.
    delete event.detail;
    const list = this.#events.get(type);
    if (list) for (const handler of [...list]) handler(event);

    if (propagate) {
      const { detail: _ignored, ...rest } = payload as T & { detail?: unknown };
      for (const parent of this.#eventParents) {
        parent.emit(type, {
          ...rest,
          sourceTarget,
          propagatedFrom: this,
          layer: payload.layer instanceof Evented ? payload.layer : this
        }, true);
      }
    }
    return this;
  }
}
